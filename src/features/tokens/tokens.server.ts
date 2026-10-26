import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
	isPermission,
	type Permission,
	withImplied,
} from "#/config/permissions.ts";
import { getConfig } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { apiTokens, teams } from "#/db/schema/teams.ts";
import { users } from "#/db/schema/user.ts";
import {
	type Actor,
	assertCanAccess,
	can,
	NIL_UUID,
} from "#/features/auth/access.ts";
import { memberActor } from "#/features/teams/membership.server.ts";
import { audit } from "#/server/services/audit.ts";
import { endSessionConnections } from "#/server/services/auth/live-connections.ts";
import { AppError } from "#/utils/error.ts";
import {
	type ApiTokenDTO,
	type CreateApiTokenInput,
	type CreatedApiToken,
	tokenPermissionIds,
} from "./schema";
import { TOKEN_PREFIX, tokenPublicPart, tokenRowPrefix } from "./token-format";

/**
 * API tokens (format: `./token-format.ts`). The random prefix (unique)
 * finds the row and identifies the token in lists. Personal tokens act as
 * their member and never beyond the member's current role; team tokens
 * carry their own permissions.
 */
export { tokenPublicPart };

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** Live connections opened with a token carry this pseudo session id. */
const tokenSessionId = (tokenId: string) => `token:${tokenId}`;

function toDTO(
	row: typeof apiTokens.$inferSelect,
	names: { createdBy: string | null; owner: string | null },
	creatorCurrent = true,
): ApiTokenDTO {
	return {
		id: row.id,
		name: row.name,
		scope: row.userId ? "personal" : "team",
		prefix: `${TOKEN_PREFIX}${row.prefix}`,
		permissions: row.permissions.filter(isPermission),
		expiresAt: row.expiresAt,
		lastUsedAt: row.lastUsedAt,
		lastUsedIp: row.lastUsedIp,
		createdAt: row.createdAt,
		createdBy: names.createdBy,
		creatorCurrent,
		owner: names.owner,
		revokedAt: row.revokedAt,
	};
}

/**
 * Tokens of the active team the caller may see: their own personal tokens,
 * plus every token with tokens.manage.
 */
export async function listApiTokens(actor: Actor): Promise<ApiTokenDTO[]> {
	const rows = await db
		.select({ token: apiTokens, creator: users.email })
		.from(apiTokens)
		.leftJoin(users, eq(users.id, apiTokens.createdBy))
		.where(
			and(
				eq(apiTokens.teamId, actor.teamId),
				isNull(apiTokens.revokedAt),
				can(actor, "tokens.manage")
					? undefined
					: eq(apiTokens.userId, actor.userId ?? NIL_UUID),
			),
		)
		.orderBy(desc(apiTokens.createdAt));
	const owners = new Map<string, string>();
	for (const row of rows) {
		if (row.token.userId && row.token.userId === row.token.createdBy) {
			owners.set(row.token.userId, row.creator ?? "");
		}
	}
	// Team tokens: is the creator still a member holding every permission?
	const creators = new Map<string, Set<string>>();
	for (const row of rows) {
		const id = row.token.createdBy;
		if (row.token.userId || !id || creators.has(id)) continue;
		const member = await memberActor(id, actor.teamId);
		creators.set(id, new Set(member ? [...member.permissions] : []));
	}
	return rows.map((row) =>
		toDTO(
			row.token,
			{
				createdBy: row.creator,
				owner: row.token.userId ? (owners.get(row.token.userId) ?? null) : null,
			},
			row.token.userId
				? true
				: !!row.token.createdBy &&
						row.token.permissions.every((id) =>
							creators.get(row.token.createdBy as string)?.has(id),
						),
		),
	);
}

export async function createApiToken(
	actor: Actor,
	input: CreateApiTokenInput,
): Promise<CreatedApiToken> {
	if (actor.via !== "session" || !actor.userId) {
		// Tokens are created by people in the panel, not by other tokens.
		throw new AppError("FORBIDDEN", { permission: "tokens.manage" });
	}
	if (input.scope === "team") assertCanAccess(actor, "tokens.manage");
	const allowed = new Set<Permission>(tokenPermissionIds);
	// Implied permissions come along (deploying needs seeing the app).
	const requested = withImplied(input.permissions);
	if (
		requested.some(
			(permission) => !allowed.has(permission) || !can(actor, permission),
		)
	) {
		throw new AppError("API_TOKEN_PERMISSIONS");
	}
	const days = Math.min(
		input.expiresInDays,
		getConfig().API_TOKEN_MAX_TTL_DAYS,
	);
	const prefix = randomBytes(9)
		.toString("base64url")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "0")
		.slice(0, 12);
	const secret = `${TOKEN_PREFIX}${prefix}_${randomBytes(32).toString("base64url")}`;
	const [row] = await db
		.insert(apiTokens)
		.values({
			teamId: actor.teamId,
			userId: input.scope === "personal" ? actor.userId : null,
			createdBy: actor.userId,
			name: input.name,
			prefix,
			tokenHash: sha256(secret).toString("hex"),
			permissions: requested,
			expiresAt: new Date(Date.now() + days * 86_400_000),
		})
		.returning();
	audit({
		actor,
		action: "api_token.create",
		targetType: "api_token",
		targetId: row.id,
		meta: {
			name: input.name,
			scope: input.scope,
			permissions: requested,
			expiresInDays: days,
		},
	});
	const [me] = await db
		.select({ email: users.email })
		.from(users)
		.where(eq(users.id, actor.userId))
		.limit(1);
	return {
		token: toDTO(row, {
			createdBy: me?.email ?? null,
			owner: input.scope === "personal" ? (me?.email ?? null) : null,
		}),
		secret,
	};
}

/** Revoke: the owner of a personal token, or anyone with tokens.manage. */
export async function revokeApiToken(actor: Actor, id: string): Promise<void> {
	const [row] = await db
		.select()
		.from(apiTokens)
		.where(and(eq(apiTokens.id, id), eq(apiTokens.teamId, actor.teamId)))
		.limit(1);
	if (!row || row.revokedAt) throw new AppError("API_TOKEN_NOT_FOUND");
	if (!(row.userId && row.userId === actor.userId)) {
		assertCanAccess(actor, "tokens.manage");
	}
	await db
		.update(apiTokens)
		.set({ revokedAt: new Date() })
		.where(eq(apiTokens.id, id));
	// Streams opened with it end now.
	endSessionConnections(tokenSessionId(id), "revoked");
	audit({
		actor,
		action: "api_token.revoke",
		targetType: "api_token",
		targetId: id,
	});
}

const touched = new Map<string, number>();

/**
 * Actor of an `Authorization: Bearer` token, or null when the token is
 * malformed, unknown, revoked or expired (or its member left the team).
 */
export async function authenticateToken(
	bearer: string,
	ip: string | null,
): Promise<Actor | null> {
	const rowPrefix = tokenRowPrefix(bearer);
	if (!rowPrefix) return null;
	const [row] = await db
		.select({ token: apiTokens, teamId: teams.id })
		.from(apiTokens)
		.innerJoin(teams, eq(teams.id, apiTokens.teamId))
		.where(and(eq(apiTokens.prefix, rowPrefix), isNull(apiTokens.revokedAt)))
		.limit(1);
	const token = row?.token;
	if (!token) return null;
	const expected = Buffer.from(token.tokenHash, "hex");
	const actual = sha256(bearer);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		return null;
	}
	if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) return null;

	// Older tokens may lack implied permissions (e.g. deploy without view).
	const granted = withImplied(token.permissions.filter(isPermission));
	let permissions = new Set<Permission>(granted);
	if (token.userId) {
		// Never beyond the member's current role (or nothing once they left).
		const member = await memberActor(token.userId, token.teamId);
		if (!member) return null;
		permissions = new Set(granted.filter((id) => member.permissions.has(id)));
	}
	const config = getConfig();
	const last = touched.get(token.id) ?? token.lastUsedAt?.getTime() ?? 0;
	if (Date.now() - last >= config.API_TOKEN_TOUCH_INTERVAL_MS) {
		touched.set(token.id, Date.now());
		void db
			.update(apiTokens)
			.set({ lastUsedAt: new Date(), lastUsedIp: ip })
			.where(eq(apiTokens.id, token.id))
			.catch(() => undefined);
	}
	return {
		userId: token.userId,
		teamId: token.teamId,
		role: null,
		permissions,
		instanceAdmin: false,
		via: "token",
		tokenId: token.id,
	};
}
