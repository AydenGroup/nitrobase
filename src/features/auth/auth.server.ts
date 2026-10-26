import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { getConfig } from "#/config/server.ts";
import { APP_ID } from "#/config/shared.ts";
import { isUniqueViolation } from "#/db/errors.ts";
import { db } from "#/db/index.ts";
import { users } from "#/db/schema/user.ts";
import { createDefaultServer } from "#/features/servers/servers.server.ts";
import {
	clearSetupToken,
	setupTokenMatches,
} from "#/features/setup/setup-token.server.ts";
import {
	consumeInvite,
	createTeamRecord,
	type InviteClaim,
} from "#/features/teams/teams.server.ts";
import { normalizeEmail } from "#/libs/email.ts";
import { AppError } from "#/utils/error.ts";
import {
	type PersistentRateLimiter,
	persistentRateLimiter,
} from "./rate-limits.server";
import type { RegisterInput, UpdateProfileInput, UserDTO } from "./schema";

/** Client-safe user columns (no password hash or 2FA secrets). */
const dtoUserColumns = {
	id: users.id,
	firstName: users.firstName,
	lastName: users.lastName,
	email: users.email,
	avatarUrl: users.avatarUrl,
	instanceAdmin: users.instanceAdmin,
	totpEnabledAt: users.totpEnabledAt,
	createdAt: users.createdAt,
	updatedAt: users.updatedAt,
} as const;

let dummyHash: string | null = null;
/** Hash compared against when the email is unknown (same bcrypt cost). */
function timingEqualizerHash(): string {
	dummyHash ??= bcrypt.hashSync(
		`${APP_ID}-timing-equalizer`,
		getConfig().PASSWORD_BCRYPT_COST,
	);
	return dummyHash;
}

/**
 * Case-insensitive email match (served by `users_email_lower_idx`). Both
 * sides go through Postgres `lower()`: JS and the database collation can
 * lowercase non-ASCII letters differently, so the input is not compared
 * against a JS-lowered string.
 */
const emailMatches = (email: string) =>
	sql`lower(${users.email}) = lower(${normalizeEmail(email)})`;

// Sign-in attempt limiters (failures only), per client IP and per account.
// Persisted in `rate_limits`: a restart does not clear a lockout.
const globalLimiters = globalThis as typeof globalThis & {
	__nitrobaseLoginLimiters?: {
		ip: PersistentRateLimiter;
		account: PersistentRateLimiter;
	};
};
async function loginLimiters() {
	const config = getConfig();
	globalLimiters.__nitrobaseLoginLimiters ??= {
		ip: persistentRateLimiter("login.ip", {
			limit: config.LOGIN_RATE_PER_IP,
			windowMs: config.LOGIN_RATE_WINDOW_MS,
		}),
		account: persistentRateLimiter("login.account", {
			limit: config.LOGIN_RATE_PER_ACCOUNT,
			windowMs: config.LOGIN_RATE_WINDOW_MS,
		}),
	};
	const limiters = globalLimiters.__nitrobaseLoginLimiters;
	await Promise.all([limiters.ip.ready(), limiters.account.ready()]);
	return limiters;
}

/**
 * Account attempts are counted per (account, IP): a stranger guessing the
 * admin password locks only themselves out, never the admin (a global
 * per-account lock would be a denial of service on a single-admin panel).
 * The per-IP limit and bcrypt cost bound guessing across accounts.
 */
const accountKey = (email: string, ip: string | null) =>
	`${normalizeEmail(email)}|${ip ?? "-"}`;

export async function isLoginLimited(
	ip: string | null,
	email: string,
): Promise<boolean> {
	const limiters = await loginLimiters();
	return (
		(ip !== null && limiters.ip.isLimited(ip)) ||
		limiters.account.isLimited(accountKey(email, ip))
	);
}

/**
 * Minutes until a limited sign-in may try again (rounded up). The window is
 * fixed from the first failure: blocked attempts are not counted.
 */
export async function loginRetryMinutes(
	ip: string | null,
	email: string,
): Promise<string> {
	const limiters = await loginLimiters();
	const ms = Math.max(
		ip ? limiters.ip.retryAfterMs(ip) : 0,
		limiters.account.retryAfterMs(accountKey(email, ip)),
	);
	return String(Math.max(1, Math.ceil(ms / 60_000)));
}

export async function recordLoginFailure(
	ip: string | null,
	email: string,
): Promise<void> {
	const limiters = await loginLimiters();
	if (ip) limiters.ip.hit(ip);
	limiters.account.hit(accountKey(email, ip));
}

export async function recordLoginSuccess(
	ip: string | null,
	email: string,
): Promise<void> {
	(await loginLimiters()).account.reset(accountKey(email, ip));
}

/**
 * True once any account exists: from then on sign-up needs an invite.
 */
export async function getExistedUser(): Promise<boolean> {
	const user = await db.query.users.findFirst();
	return !!user;
}

/**
 * Verifies email + password with bcrypt and returns the user without secret
 * columns. Unknown email and wrong password raise the same error.
 * Rate limiting and session creation are the caller's job.
 */
export async function authenticateUser(
	email: string,
	password: string,
): Promise<UserDTO> {
	const user = await db.query.users.findFirst({ where: emailMatches(email) });
	if (!user) {
		// Same cost as a wrong password: no account enumeration by timing.
		await bcrypt.compare(password, timingEqualizerHash());
		throw new AppError("AUTH_INVALID_CREDENTIALS");
	}
	const isValidPassword = await bcrypt.compare(password, user.passwordHash);
	if (!isValidPassword) {
		throw new AppError("AUTH_INVALID_CREDENTIALS");
	}
	const {
		passwordHash: _,
		totpSecretEncrypted: _secret,
		totpPendingSecretEncrypted: _pending,
		totpLastStep: _step,
		...userDTO
	} = user;
	return userDTO;
}

/** User by id without secret columns; undefined when not found. */
export async function getUserById(
	userId: string,
): Promise<UserDTO | undefined> {
	const user = await db.query.users.findFirst({
		where: (users, { eq }) => eq(users.id, userId),
		columns: {
			passwordHash: false,
			totpSecretEncrypted: false,
			totpPendingSecretEncrypted: false,
			totpLastStep: false,
		},
	});
	return user;
}

/** User by email (case-insensitive) without secret columns; undefined when not found. */
export async function getUserByEmail(
	email: string,
): Promise<UserDTO | undefined> {
	const user = await db.query.users.findFirst({
		where: emailMatches(email),
		columns: {
			passwordHash: false,
			totpSecretEncrypted: false,
			totpPendingSecretEncrypted: false,
			totpLastStep: false,
		},
	});
	return user;
}

// Arbitrary constant key for pg_advisory_xact_lock around first-admin setup.
export const REGISTRATION_LOCK_KEY = 4_242_001;

/**
 * Create an account. Without an invite this is the bootstrap: only allowed
 * while no account exists (checked under an advisory lock, so two
 * concurrent registrations can't both win) and creates the instance admin,
 * their personal team and its default (local) server. With an invite the
 * account joins the inviting team (see `consumeInvite`). A unique-email
 * violation maps to AUTH_EMAIL_IN_USE.
 */
export async function createUser(
	data: RegisterInput,
	invite: InviteClaim | undefined,
): Promise<UserDTO> {
	const passwordHash = await bcrypt.hash(
		data.password,
		getConfig().PASSWORD_BCRYPT_COST,
	);
	return db
		.transaction(async (tx) => {
			await tx.execute(
				sql`select pg_advisory_xact_lock(${REGISTRATION_LOCK_KEY})`,
			);
			const existing = await tx.select({ id: users.id }).from(users).limit(1);
			const bootstrap = existing.length === 0;
			if (!bootstrap && !invite) throw new AppError("INVITE_REQUIRED");
			// The first account needs the one-time setup token (SETUP_TOKEN,
			// else the one the panel generated and logged).
			if (bootstrap && !(await setupTokenMatches(data.setupToken))) {
				throw new AppError("SETUP_TOKEN_INVALID");
			}

			const [newUser] = await tx
				.insert(users)
				.values({
					firstName: data.firstName,
					lastName: data.lastName,
					email: normalizeEmail(data.email),
					passwordHash,
					instanceAdmin: bootstrap,
				})
				.returning(dtoUserColumns);
			if (bootstrap) {
				await clearSetupToken(tx);
				const team = await createTeamRecord(tx, null, newUser.id, true);
				await createDefaultServer({ teamId: team.id, userId: newUser.id }, tx);
			} else if (invite) {
				await consumeInvite(tx, invite, newUser);
			}
			return newUser;
		})
		.catch(mapEmailConflict);
}

function mapEmailConflict(error: unknown): never {
	if (isUniqueViolation(error)) throw new AppError("AUTH_EMAIL_IN_USE");
	throw error;
}

/**
 * Updates the profile after re-verifying `currentPassword`. A non-empty
 * `newPassword` is re-hashed; `passwordChanged` lets the caller react
 * (e.g. revoke other sessions). An email owned by another account raises
 * AUTH_EMAIL_IN_USE (checked here and enforced by the unique index).
 */
export async function updateUser(
	userId: string,
	data: UpdateProfileInput,
): Promise<UserDTO & { passwordChanged: boolean }> {
	const user = await db.query.users.findFirst({
		where: (users, { eq }) => eq(users.id, userId),
	});
	if (!user) {
		throw new AppError("AUTH_USER_NOT_FOUND");
	}

	const validPassword = await bcrypt.compare(
		data.currentPassword,
		user.passwordHash,
	);
	if (!validPassword) {
		throw new AppError("AUTH_CURRENT_PASSWORD_INCORRECT");
	}

	const email = normalizeEmail(data.email);
	const owner = await getUserByEmail(email);
	if (owner && owner.id !== userId) throw new AppError("AUTH_EMAIL_IN_USE");

	const passwordHash = data.newPassword
		? await bcrypt.hash(data.newPassword, getConfig().PASSWORD_BCRYPT_COST)
		: undefined;

	const [updated] = await db
		.update(users)
		.set({
			firstName: data.firstName,
			lastName: data.lastName,
			email,
			...(passwordHash && { passwordHash }),
			...(data.avatarUrl !== undefined && { avatarUrl: data.avatarUrl }),
			updatedAt: new Date(),
		})
		.where(eq(users.id, userId))
		.returning(dtoUserColumns)
		.catch(mapEmailConflict);

	return { ...updated, passwordChanged: !!passwordHash };
}
