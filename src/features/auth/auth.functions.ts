import { createServerFn } from "@tanstack/react-start";
import { getConfig } from "#/config/server.ts";
import { InviteTokenSchema } from "#/features/teams/schema.ts";
import { findInvite } from "#/features/teams/teams.server.ts";
import { i18nMiddleware } from "#/libs/i18n.ts";
import { audit } from "#/server/services/audit.ts";
import { currentRequestInfo } from "#/server/services/request-info.ts";
import { AppError } from "#/utils/error.ts";
import {
	openAppSession,
	REMEMBER_ME_MAX_AGE,
	SESSION_MAX_AGE,
} from "#/utils/session.ts";
import {
	authenticateUser,
	createUser,
	getExistedUser,
	getUserByEmail,
	getUserById,
	isLoginLimited,
	loginRetryMinutes,
	recordLoginFailure,
	recordLoginSuccess,
	recordRegisterFailure,
	registerRetryMinutes,
	updateUser,
} from "./auth.server";
import { authMiddleware } from "./authMiddleware";
import {
	type LoginResult,
	LoginSchema,
	RegisterSchema,
	TwoFactorCodeSchema,
	UpdateProfileSchema,
} from "./schema";
import {
	createSession,
	resolveSession,
	revokeOtherSessions,
	revokeSession,
} from "./sessions.server";
import { verifySecondFactor } from "./two-factor.server";

/** Server-side session lifetime. */
const maxAgeFor = (rememberMe: boolean | undefined) =>
	rememberMe ? REMEMBER_ME_MAX_AGE : SESSION_MAX_AGE;
/** Cookie lifetime: without remember-me, a browser-session cookie. */
const cookieAgeFor = (rememberMe: boolean | undefined) =>
	rememberMe ? REMEMBER_ME_MAX_AGE : ("browser" as const);

/** Create the session row and write its id into the sealed cookie. */
async function completeLogin(
	user: { id: string; email: string },
	rememberMe: boolean,
): Promise<void> {
	const maxAge = maxAgeFor(rememberMe);
	const info = currentRequestInfo();
	const sid = await createSession(user.id, maxAge, info);
	const session = await openAppSession(cookieAgeFor(rememberMe));
	await session.update({
		sid,
		userId: user.id,
		email: user.email,
		pending2fa: undefined,
	});
	audit({
		userId: user.id,
		action: "auth.login",
		targetType: "session",
		targetId: sid,
		request: info,
	});
}

/**
 * Login step 1: email + password, rate limited per IP and per account+IP.
 * Without 2FA this signs in directly; with 2FA it only records a pending
 * sign-in in the cookie and asks for a code.
 */
export const loginFn = createServerFn({ method: "POST" })
	// Raw input is accepted here and parsed in the handler, where the
	// request-scoped `i18n` (from i18nMiddleware) can localize Zod messages.
	.validator((data) => data)
	.middleware([i18nMiddleware])
	.handler(async ({ data, context }): Promise<LoginResult> => {
		const parsed = LoginSchema(context.i18n).parse(data);
		const info = currentRequestInfo();
		if (await isLoginLimited(info.ip, parsed.email)) {
			audit({
				userId: null,
				action: "auth.login_rate_limited",
				meta: { email: parsed.email },
				request: info,
			});
			throw new AppError("AUTH_RATE_LIMITED", {
				minutes: await loginRetryMinutes(info.ip, parsed.email),
			});
		}
		let user: Awaited<ReturnType<typeof authenticateUser>>;
		try {
			user = await authenticateUser(parsed.email, parsed.password);
		} catch (error) {
			await recordLoginFailure(info.ip, parsed.email);
			audit({
				userId: (await getUserByEmail(parsed.email))?.id ?? null,
				action: "auth.login_failed",
				targetType: "user",
				meta: { email: parsed.email },
				request: info,
			});
			throw error;
		}
		await recordLoginSuccess(info.ip, parsed.email);
		if (user.totpEnabledAt) {
			// Password only proves half: no userId in the cookie until the code.
			const session = await openAppSession(cookieAgeFor(parsed.rememberMe));
			await session.update({
				sid: undefined,
				userId: undefined,
				email: undefined,
				pending2fa: {
					userId: user.id,
					rememberMe: !!parsed.rememberMe,
					at: Date.now(),
				},
			});
			return { twoFactorRequired: true };
		}
		await completeLogin(user, !!parsed.rememberMe);
		return { twoFactorRequired: false };
	});

/** Login step 2: authenticator or recovery code for the pending sign-in. */
export const verifyLoginTwoFactorFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware])
	.handler(async ({ data, context }) => {
		const { code } = TwoFactorCodeSchema(context.i18n).parse(data);
		const session = await openAppSession();
		const pending = session.data?.pending2fa;
		if (
			!pending ||
			Date.now() - pending.at > getConfig().TWO_FACTOR_PENDING_TTL_MS
		) {
			throw new AppError("AUTH_2FA_EXPIRED");
		}
		const info = currentRequestInfo();
		if (info.ip && (await isLoginLimited(info.ip, `2fa:${pending.userId}`))) {
			throw new AppError("AUTH_RATE_LIMITED", {
				minutes: await loginRetryMinutes(info.ip, `2fa:${pending.userId}`),
			});
		}
		try {
			await verifySecondFactor(pending.userId, code);
		} catch (error) {
			await recordLoginFailure(info.ip, `2fa:${pending.userId}`);
			throw error;
		}
		const user = await getUserById(pending.userId);
		if (!user) throw new AppError("AUTH_2FA_EXPIRED");
		await completeLogin(user, pending.rememberMe);
	});

/**
 * Sign-up. The first account bootstraps the instance (instance admin,
 * personal team, default local server); after that an invite token is
 * required and the account joins the inviting team. Without a valid invite
 * a set-up panel answers the same for every email (no account enumeration).
 */
export const registerFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware])
	.handler(async ({ data, context }) => {
		const parsed = RegisterSchema(context.i18n).parse(data);
		const token =
			data && typeof data === "object" && "invite" in data && data.invite
				? InviteTokenSchema.parse(data.invite)
				: null;
		// Unauthenticated: failed attempts (setup token, invite) are limited
		// per client address.
		const { ip } = currentRequestInfo();
		const minutes = registerRetryMinutes(ip);
		if (minutes) throw new AppError("AUTH_RATE_LIMITED", { minutes });

		let newUser: Awaited<ReturnType<typeof createUser>>;
		let claim: Awaited<ReturnType<typeof findInvite>> | undefined;
		try {
			if (await getExistedUser()) {
				if (!token) throw new AppError("INVITE_REQUIRED");
				claim = await findInvite(token);
			}
			newUser = await createUser(parsed, claim);
		} catch (error) {
			recordRegisterFailure(ip);
			throw error;
		}
		audit({
			userId: newUser.id,
			teamId: claim?.teamId ?? null,
			action: claim ? "team.invite.accept" : "auth.register",
			targetType: claim ? "invite" : "user",
			targetId: claim?.id,
			meta: claim ? { role: claim.role, signup: true } : undefined,
		});
		await completeLogin(newUser, false);
	});

/** Revokes the current session row (if any) and clears the session cookie. */
export const logoutFn = createServerFn({ method: "POST" }).handler(async () => {
	const session = await openAppSession();
	const resolved = await resolveSession(session.data);
	if (resolved) {
		await revokeSession(resolved.userId, resolved.sessionId).catch(() => {});
		audit({
			userId: resolved.userId,
			action: "auth.logout",
			targetType: "session",
			targetId: resolved.sessionId,
		});
	}
	await session.clear();
});

/**
 * The signed-in user, or null for anonymous, pending-2FA, revoked or
 * expired sessions. Does not throw: used by the root route on every page.
 */
export const getCurrentUserFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const session = await openAppSession();
		const resolved = await resolveSession(session.data);
		if (!resolved) return null;
		return (await getUserById(resolved.userId)) ?? null;
	},
);

export const isInitialSetupCompleteFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const user = await getExistedUser();
	return !!user;
});

/**
 * Updates the signed-in user's profile (current password required) and
 * refreshes the identity stored in the cookie.
 */
export const updateProfileFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, authMiddleware])
	.handler(async ({ data, context }) => {
		const parsed = UpdateProfileSchema(context.i18n).parse(data);

		const userId = context.user.userId;
		const session = await openAppSession();
		const { passwordChanged, ...updated } = await updateUser(userId, parsed);
		await session.update({ userId: updated.id, email: updated.email });
		if (passwordChanged) {
			// A changed password signs out every other browser.
			const revoked = await revokeOtherSessions(userId, context.user.sessionId);
			audit({
				userId,
				action: "auth.password.change",
				targetType: "user",
				meta: { otherSessionsRevoked: revoked },
			});
		} else {
			audit({ userId, action: "auth.profile.update", targetType: "user" });
		}
		return updated;
	});
