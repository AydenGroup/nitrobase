import type { I18n } from "@lingui/core";
import { z } from "zod";
import {
	isPermission,
	type Permission,
	teamPermissionIds,
} from "#/config/permissions.ts";
import { MAX_DAYS } from "#/config/shared.ts";

/** Lifetimes offered when creating a token (days). */
export const API_TOKEN_EXPIRY_DAYS = [7, 30, 90, 365] as const;

const TOKEN_SCOPES = ["personal", "team"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** Team permissions a token may carry (never instance ones). */
export const tokenPermissionIds: Permission[] = teamPermissionIds;

export const CreateApiTokenSchema = (i18n: I18n) =>
	z.object({
		name: z
			.string()
			.trim()
			.min(1, i18n._("Enter a name"))
			.max(80, i18n._("Use at most 80 characters")),
		scope: z.enum(TOKEN_SCOPES),
		permissions: z
			.array(z.string())
			.min(1, i18n._("Pick at least one permission"))
			.max(64)
			.refine(
				(items) => items.every(isPermission),
				i18n._("Unknown permission"),
			)
			.transform((items) => [...new Set(items)] as Permission[]),
		expiresInDays: z.coerce.number().int().min(1).max(MAX_DAYS),
	});
export type CreateApiTokenInput = z.infer<
	ReturnType<typeof CreateApiTokenSchema>
>;

export interface ApiTokenDTO {
	id: string;
	name: string;
	scope: TokenScope;
	/** Public part shown in lists (`nbk_<prefix>…`). */
	prefix: string;
	permissions: Permission[];
	expiresAt: Date | null;
	lastUsedAt: Date | null;
	lastUsedIp: string | null;
	createdAt: Date;
	createdBy: string | null;
	/**
	 * Team tokens keep their permissions when their creator leaves or is
	 * demoted: false flags such a token for review.
	 */
	creatorCurrent: boolean;
	/** Personal tokens: the member they act as. */
	owner: string | null;
	revokedAt: Date | null;
}

export interface CreatedApiToken {
	token: ApiTokenDTO;
	/** The secret, shown once. */
	secret: string;
}
