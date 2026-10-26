import bcrypt from "bcryptjs";
import { and, eq, isNull, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { getConfig } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { userRecoveryCodes, users } from "#/db/schema/user.ts";
import { audit } from "#/server/services/audit.ts";
import {
	generateRecoveryCodes,
	hashRecoveryCode,
	looksLikeRecoveryCode,
} from "#/server/services/auth/recovery.ts";
import {
	base32Decode,
	generateTotpSecret,
	otpauthUri,
	verifyTotp,
} from "#/server/services/auth/totp.ts";
import { decrypt, encrypt } from "#/utils/crypto.ts";
import { AppError } from "#/utils/error.ts";
import {
	type PersistentRateLimiter,
	persistentRateLimiter,
} from "./rate-limits.server";
import type { TwoFactorEnrollment, TwoFactorStatus } from "./schema";
import { revokeOtherSessions } from "./sessions.server";

// Per-user limiter of 2FA code attempts (login step 2 and settings),
// persisted in `rate_limits` so a restart does not clear it.
const globalLimiter = globalThis as typeof globalThis & {
	__nitrobaseTwoFactorLimiter?: PersistentRateLimiter;
};
async function loadLimiter(): Promise<PersistentRateLimiter> {
	const config = getConfig();
	globalLimiter.__nitrobaseTwoFactorLimiter ??= persistentRateLimiter("2fa", {
		limit: config.TWO_FACTOR_RATE_PER_USER,
		windowMs: config.TWO_FACTOR_RATE_WINDOW_MS,
	});
	await globalLimiter.__nitrobaseTwoFactorLimiter.ready();
	return globalLimiter.__nitrobaseTwoFactorLimiter;
}

async function userRow(userId: string) {
	const [user] = await db
		.select()
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!user) throw new AppError("AUTH_USER_NOT_FOUND");
	return user;
}

async function assertPassword(
	user: { passwordHash: string },
	password: string,
): Promise<void> {
	if (!(await bcrypt.compare(password, user.passwordHash))) {
		throw new AppError("AUTH_CURRENT_PASSWORD_INCORRECT");
	}
}

export async function getTwoFactorStatus(
	userId: string,
): Promise<TwoFactorStatus> {
	const user = await userRow(userId);
	const [left] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(userRecoveryCodes)
		.where(
			and(
				eq(userRecoveryCodes.userId, userId),
				isNull(userRecoveryCodes.usedAt),
			),
		);
	return {
		enabled: !!user.totpEnabledAt,
		enabledAt: user.totpEnabledAt,
		recoveryCodesLeft: left?.count ?? 0,
	};
}

/** Step 1: a new secret (kept pending until a code confirms it). */
export async function startEnrollment(
	userId: string,
	password: string,
): Promise<TwoFactorEnrollment> {
	const user = await userRow(userId);
	if (user.totpEnabledAt) throw new AppError("AUTH_2FA_ALREADY_ENABLED");
	await assertPassword(user, password);
	const secret = generateTotpSecret();
	await db
		.update(users)
		.set({ totpPendingSecretEncrypted: encrypt(secret) })
		.where(eq(users.id, userId));
	const uri = otpauthUri({
		issuer: getConfig().TOTP_ISSUER,
		account: user.email,
		secret,
	});
	const svg = await QRCode.toString(uri, { type: "svg", margin: 1 });
	audit({ userId, action: "auth.2fa.enroll_start", targetType: "user" });
	return {
		secret,
		qrDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
	};
}

async function replaceRecoveryCodes(userId: string): Promise<string[]> {
	const codes = generateRecoveryCodes(getConfig().TWO_FACTOR_RECOVERY_CODES);
	await db.transaction(async (tx) => {
		await tx
			.delete(userRecoveryCodes)
			.where(eq(userRecoveryCodes.userId, userId));
		await tx
			.insert(userRecoveryCodes)
			.values(
				codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })),
			);
	});
	return codes;
}

/** Step 2: the first code turns 2FA on; recovery codes are shown once. */
export async function confirmEnrollment(
	userId: string,
	code: string,
	/** The enrolling browser stays signed in; every other session ends. */
	keepSessionId?: string,
): Promise<{ recoveryCodes: string[]; otherSessionsRevoked: number }> {
	const user = await userRow(userId);
	if (user.totpEnabledAt) throw new AppError("AUTH_2FA_ALREADY_ENABLED");
	if (!user.totpPendingSecretEncrypted) {
		throw new AppError("AUTH_2FA_NO_ENROLLMENT");
	}
	const secret = decrypt(user.totpPendingSecretEncrypted);
	const step = await checkLimited(userId, () =>
		verifyTotp(base32Decode(secret), code, {
			nowMs: Date.now(),
			window: getConfig().TOTP_WINDOW,
		}),
	);
	if (step === null) {
		audit({ userId, action: "auth.2fa.verify_failed", targetType: "user" });
		throw new AppError("AUTH_2FA_INVALID");
	}
	await db
		.update(users)
		.set({
			totpSecretEncrypted: encrypt(secret),
			totpPendingSecretEncrypted: null,
			totpEnabledAt: new Date(),
			totpLastStep: step,
			updatedAt: new Date(),
		})
		.where(eq(users.id, userId));
	const recoveryCodes = await replaceRecoveryCodes(userId);
	// 2FA is often turned on after a suspected compromise: end other sessions.
	const otherSessionsRevoked = await revokeOtherSessions(userId, keepSessionId);
	audit({
		userId,
		action: "auth.2fa.enable",
		targetType: "user",
		meta: { otherSessionsRevoked },
	});
	return { recoveryCodes, otherSessionsRevoked };
}

/** Rate-limited check: throws AUTH_RATE_LIMITED, counts failures. */
async function checkLimited<T>(
	userId: string,
	check: () => T | null,
): Promise<T | null> {
	const limiter = await loadLimiter();
	if (limiter.isLimited(userId)) {
		throw new AppError("AUTH_RATE_LIMITED", {
			minutes: String(
				Math.max(1, Math.ceil(limiter.retryAfterMs(userId) / 60_000)),
			),
		});
	}
	const result = check();
	if (result === null) limiter.hit(userId);
	else limiter.reset(userId);
	return result;
}

/**
 * Verify a second factor: an authenticator code (never the same time step
 * twice) or an unused recovery code (marked used atomically).
 */
export async function verifySecondFactor(
	userId: string,
	code: string,
): Promise<"totp" | "recovery"> {
	const limiter = await loadLimiter();
	if (limiter.isLimited(userId)) {
		throw new AppError("AUTH_RATE_LIMITED", {
			minutes: String(
				Math.max(1, Math.ceil(limiter.retryAfterMs(userId) / 60_000)),
			),
		});
	}
	const user = await userRow(userId);
	if (!user.totpEnabledAt || !user.totpSecretEncrypted) {
		throw new AppError("AUTH_2FA_NOT_ENABLED");
	}
	if (looksLikeRecoveryCode(code)) {
		const [used] = await db
			.update(userRecoveryCodes)
			.set({ usedAt: new Date() })
			.where(
				and(
					eq(userRecoveryCodes.userId, userId),
					eq(userRecoveryCodes.codeHash, hashRecoveryCode(code)),
					isNull(userRecoveryCodes.usedAt),
				),
			)
			.returning({ id: userRecoveryCodes.id });
		if (used) {
			limiter.reset(userId);
			audit({ userId, action: "auth.2fa.recovery_used", targetType: "user" });
			return "recovery";
		}
	} else {
		const step = verifyTotp(
			base32Decode(decrypt(user.totpSecretEncrypted)),
			code,
			{
				nowMs: Date.now(),
				window: getConfig().TOTP_WINDOW,
				lastStep: user.totpLastStep,
			},
		);
		if (step !== null) {
			// Conditional update: two parallel requests can't both use a step.
			const [accepted] = await db
				.update(users)
				.set({ totpLastStep: step })
				.where(
					and(
						eq(users.id, userId),
						sql`coalesce(${users.totpLastStep}, -1) < ${step}`,
					),
				)
				.returning({ id: users.id });
			if (accepted) {
				limiter.reset(userId);
				return "totp";
			}
		}
	}
	limiter.hit(userId);
	audit({ userId, action: "auth.2fa.verify_failed", targetType: "user" });
	throw new AppError("AUTH_2FA_INVALID");
}

/** Turning 2FA off needs the password and a current code. */
export async function disableTwoFactor(
	userId: string,
	password: string,
	code: string,
): Promise<void> {
	const user = await userRow(userId);
	if (!user.totpEnabledAt) throw new AppError("AUTH_2FA_NOT_ENABLED");
	await assertPassword(user, password);
	await verifySecondFactor(userId, code);
	await db
		.update(users)
		.set({
			totpSecretEncrypted: null,
			totpPendingSecretEncrypted: null,
			totpEnabledAt: null,
			totpLastStep: null,
			updatedAt: new Date(),
		})
		.where(eq(users.id, userId));
	await db
		.delete(userRecoveryCodes)
		.where(eq(userRecoveryCodes.userId, userId));
	audit({ userId, action: "auth.2fa.disable", targetType: "user" });
}

export async function regenerateRecoveryCodes(
	userId: string,
	password: string,
	code: string,
): Promise<{ recoveryCodes: string[] }> {
	const user = await userRow(userId);
	if (!user.totpEnabledAt) throw new AppError("AUTH_2FA_NOT_ENABLED");
	await assertPassword(user, password);
	await verifySecondFactor(userId, code);
	const recoveryCodes = await replaceRecoveryCodes(userId);
	audit({ userId, action: "auth.2fa.recovery_regenerate", targetType: "user" });
	return { recoveryCodes };
}
