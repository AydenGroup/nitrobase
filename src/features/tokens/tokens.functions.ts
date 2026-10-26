import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { i18nMiddleware } from "#/libs/i18n.ts";
import { CreateApiTokenSchema } from "./schema";
import { createApiToken, listApiTokens, revokeApiToken } from "./tokens.server";

/** Own personal tokens, plus every team token with tokens.manage. */
export const listApiTokensFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("team.view")])
	.handler(async ({ context }) => listApiTokens(context.actor));

/**
 * Personal tokens: any member, with permissions they hold. Team tokens:
 * tokens.manage (checked in createApiToken). The secret is returned once.
 */
export const createApiTokenFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("team.view")])
	.handler(async ({ context, data }) =>
		createApiToken(
			context.actor,
			CreateApiTokenSchema(context.i18n).parse(data),
		),
	);

export const revokeApiTokenFn = createServerFn({ method: "POST" })
	.validator((id: string) => z.guid().parse(id))
	.middleware([requirePermission("team.view")])
	.handler(async ({ context, data }) => {
		await revokeApiToken(context.actor, data);
		return { success: true };
	});
