import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { i18nMiddleware } from "#/libs/i18n.ts";
import { audit } from "#/server/services/audit.ts";
import { authMiddleware } from "./authMiddleware";
import {
	SessionIdSchema,
	TwoFactorCodeSchema,
	TwoFactorConfirmSchema,
} from "./schema";
import {
	listSessions,
	revokeOtherSessions,
	revokeSession,
} from "./sessions.server";
import {
	confirmEnrollment,
	disableTwoFactor,
	getTwoFactorStatus,
	regenerateRecoveryCodes,
	startEnrollment,
} from "./two-factor.server";

export const getTwoFactorStatusFn = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(async ({ context }) => getTwoFactorStatus(context.user.userId));

export const startTwoFactorEnrollmentFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z.object({ password: z.string().min(1) }).parse(data),
	)
	.middleware([authMiddleware])
	.handler(async ({ context, data }) =>
		startEnrollment(context.user.userId, data.password),
	);

export const confirmTwoFactorEnrollmentFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, authMiddleware])
	.handler(async ({ context, data }) => {
		const { code } = TwoFactorCodeSchema(context.i18n).parse(data);
		return confirmEnrollment(context.user.userId, code, context.user.sessionId);
	});

export const disableTwoFactorFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, authMiddleware])
	.handler(async ({ context, data }) => {
		const { password, code } = TwoFactorConfirmSchema(context.i18n).parse(data);
		await disableTwoFactor(context.user.userId, password, code);
		return { success: true };
	});

export const regenerateRecoveryCodesFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, authMiddleware])
	.handler(async ({ context, data }) => {
		const { password, code } = TwoFactorConfirmSchema(context.i18n).parse(data);
		return regenerateRecoveryCodes(context.user.userId, password, code);
	});

export const listSessionsFn = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(async ({ context }) =>
		listSessions(context.user.userId, context.user.sessionId),
	);

export const revokeSessionFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => SessionIdSchema.parse(data))
	.middleware([authMiddleware])
	.handler(async ({ context, data }) => {
		await revokeSession(context.user.userId, data.id);
		audit({
			userId: context.user.userId,
			action: "auth.session.revoke",
			targetType: "session",
			targetId: data.id,
		});
		return { success: true };
	});

export const revokeOtherSessionsFn = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.handler(async ({ context }) => {
		const revoked = await revokeOtherSessions(
			context.user.userId,
			context.user.sessionId,
		);
		audit({
			userId: context.user.userId,
			action: "auth.session.revoke_others",
			targetType: "user",
			meta: { revoked },
		});
		return { revoked };
	});
