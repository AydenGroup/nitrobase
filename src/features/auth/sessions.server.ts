import { and, desc, eq, gt, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { isPermission, type Permission } from "#/config/permissions.ts";
import { getConfig } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { apiTokens } from "#/db/schema/teams.ts";
import { sessions, users } from "#/db/schema/user.ts";
import { stillAllowed } from "#/features/teams/membership.server.ts";
import {
	accessKey,
	configureAccessRevalidation,
	configureRevalidation,
	endSessionConnections,
	endUserConnections,
	type LiveConnection,
	registerConnection,
	type SessionEndReason,
	sessionBoundSignal,
} from "#/server/services/auth/live-connections.ts";
import {
	checkSession,
	isNewDevice,
} from "#/server/services/auth/session-check.ts";
import { emitEvent } from "#/server/services/events/bus.ts";
import type { RequestInfo } from "#/server/services/request-info.ts";
import { AppError } from "#/utils/error.ts";
import type { SessionData } from "#/utils/session.ts";
import type { Actor } from "./access";
import type { SessionDTO } from "./schema";

/** Create the server-side session of a completed sign-in. */
export async function createSession(
	userId: string,
	maxAgeSeconds: number,
	info: RequestInfo,
): Promise<string> {
	const previous = await db
		.select({ ip: sessions.ip, userAgent: sessions.userAgent })
		.from(sessions)
		.where(eq(sessions.userId, userId))
		.orderBy(desc(sessions.createdAt))
		.limit(200);
	const [row] = await db
		.insert(sessions)
		.values({
			userId,
			expiresAt: new Date(Date.now() + maxAgeSeconds * 1000),
			ip: info.ip,
			userAgent: info.userAgent,
		})
		.returning({ id: sessions.id });
	if (isNewDevice(previous, info)) {
		emitEvent({
			id: "security.new_login",
			teamId: null,
			userId,
			subject: `${info.ip ?? ""}|${info.userAgent ?? ""}`,
			params: {
				ip: info.ip ?? "?",
				device: info.userAgent ?? "?",
			},
		});
	}
	return row.id;
}

/**
 * The signed-in user of a session cookie, or null when the session row is
 * missing, revoked, expired or belongs to someone else. Writes lastSeen at
 * most every SESSION_TOUCH_INTERVAL_MS.
 */
export async function resolveSession(
	data: SessionData | undefined,
): Promise<{ userId: string; email: string; sessionId: string } | null> {
	if (!data?.sid || !data.userId) return null;
	const [row] = await db
		.select({
			userId: sessions.userId,
			expiresAt: sessions.expiresAt,
			lastSeenAt: sessions.lastSeenAt,
			revokedAt: sessions.revokedAt,
			email: users.email,
		})
		.from(sessions)
		.innerJoin(users, eq(users.id, sessions.userId))
		.where(eq(sessions.id, data.sid))
		.limit(1);
	const now = new Date();
	const verdict = checkSession(
		row,
		data.userId,
		now,
		getConfig().SESSION_TOUCH_INTERVAL_MS,
	);
	if (!verdict.valid) return null;
	if (verdict.touch) {
		await db
			.update(sessions)
			.set({ lastSeenAt: now })
			.where(eq(sessions.id, data.sid));
	}
	return { userId: row.userId, email: row.email, sessionId: data.sid };
}

export async function listSessions(
	userId: string,
	currentId: string | undefined,
): Promise<SessionDTO[]> {
	const rows = await db
		.select()
		.from(sessions)
		.where(
			and(
				eq(sessions.userId, userId),
				isNull(sessions.revokedAt),
				// Expired rows stay for new-device checks, not in the list.
				gt(sessions.expiresAt, new Date()),
			),
		)
		.orderBy(desc(sessions.lastSeenAt));
	return rows.map((row) => ({
		id: row.id,
		createdAt: row.createdAt,
		lastSeenAt: row.lastSeenAt,
		expiresAt: row.expiresAt,
		ip: row.ip,
		userAgent: row.userAgent,
		current: row.id === currentId,
	}));
}

export async function revokeSession(
	userId: string,
	sessionId: string,
): Promise<void> {
	const updated = await db
		.update(sessions)
		.set({ revokedAt: new Date() })
		.where(
			and(
				eq(sessions.id, sessionId),
				eq(sessions.userId, userId),
				isNull(sessions.revokedAt),
			),
		)
		.returning({ id: sessions.id });
	if (updated.length === 0) throw new AppError("SESSION_NOT_FOUND");
	endSessionConnections(sessionId);
}

/** Revoke every session of the user except `keepId`. Returns the count. */
export async function revokeOtherSessions(
	userId: string,
	keepId: string | undefined,
): Promise<number> {
	const updated = await db
		.update(sessions)
		.set({ revokedAt: new Date() })
		.where(
			and(
				eq(sessions.userId, userId),
				isNull(sessions.revokedAt),
				keepId ? ne(sessions.id, keepId) : undefined,
			),
		)
		.returning({ id: sessions.id });
	endUserConnections(userId, { exceptSessionId: keepId });
	return updated.length;
}

// ---------------------------------------------------------------------------
// Long-lived connections (terminal WebSockets, SSE streams)

/** Live connections opened with an API token use `token:<id>` as session id. */
const TOKEN_SESSION_PREFIX = "token:";

/** Bulk session check for the live-connection backstop. */
async function validateLiveSessions(
	all: { sessionId: string; userId: string }[],
): Promise<Map<string, SessionEndReason | null>> {
	const tokenEntries = all.filter((entry) =>
		entry.sessionId.startsWith(TOKEN_SESSION_PREFIX),
	);
	const entries = all.filter(
		(entry) => !entry.sessionId.startsWith(TOKEN_SESSION_PREFIX),
	);
	const tokenVerdicts = await validateTokenConnections(
		tokenEntries.map((entry) =>
			entry.sessionId.slice(TOKEN_SESSION_PREFIX.length),
		),
	);
	// null = still valid; a token missing from the answer is invalid.
	const tokenVerdict = (sessionId: string): SessionEndReason | null => {
		const id = sessionId.slice(TOKEN_SESSION_PREFIX.length);
		return tokenVerdicts.has(id) ? (tokenVerdicts.get(id) ?? null) : "invalid";
	};
	if (entries.length === 0) {
		return new Map(
			tokenEntries.map((entry) => [
				entry.sessionId,
				tokenVerdict(entry.sessionId),
			]),
		);
	}
	const rows = await db
		.select({
			id: sessions.id,
			userId: sessions.userId,
			expiresAt: sessions.expiresAt,
			lastSeenAt: sessions.lastSeenAt,
			revokedAt: sessions.revokedAt,
		})
		.from(sessions)
		.innerJoin(users, eq(users.id, sessions.userId))
		.where(
			inArray(
				sessions.id,
				entries.map((entry) => entry.sessionId),
			),
		);
	const byId = new Map(rows.map((row) => [row.id, row]));
	const now = new Date();
	return new Map([
		...tokenEntries.map(
			(entry) => [entry.sessionId, tokenVerdict(entry.sessionId)] as const,
		),
		...entries.map((entry) => {
			const verdict = checkSession(
				byId.get(entry.sessionId),
				entry.userId,
				now,
				Number.POSITIVE_INFINITY,
			);
			return [
				entry.sessionId,
				verdict.valid
					? null
					: verdict.reason === "expired"
						? "expired"
						: verdict.reason === "revoked"
							? "revoked"
							: "invalid",
			] as const;
		}),
	]);
}

/** Token ids -> null while the token still works, else why not. */
async function validateTokenConnections(
	ids: string[],
): Promise<Map<string, SessionEndReason | null>> {
	if (ids.length === 0) return new Map();
	const rows = await db
		.select({
			id: apiTokens.id,
			revokedAt: apiTokens.revokedAt,
			expiresAt: apiTokens.expiresAt,
		})
		.from(apiTokens)
		.where(inArray(apiTokens.id, ids));
	const byId = new Map(rows.map((row) => [row.id, row]));
	const now = Date.now();
	return new Map(
		ids.map((id) => {
			const row = byId.get(id);
			if (!row || row.revokedAt) return [id, "revoked"];
			if (row.expiresAt && row.expiresAt.getTime() <= now) {
				return [id, "expired"];
			}
			return [id, null];
		}),
	);
}

/** Team access re-check of live connections (removed members, lost roles). */
async function validateLiveAccess(
	entries: { userId: string; teamId: string; permission: string }[],
): Promise<Set<string>> {
	const denied = new Set<string>();
	for (const entry of entries) {
		if (!isPermission(entry.permission)) {
			denied.add(accessKey(entry));
			continue;
		}
		// Team tokens act without a member: their access is the token's.
		if (entry.userId.startsWith(TOKEN_SESSION_PREFIX)) continue;
		if (!(await stillAllowed(entry.userId, entry.teamId, entry.permission))) {
			denied.add(accessKey(entry));
		}
	}
	return denied;
}

let revalidationConfigured = false;
function ensureRevalidation(): void {
	if (revalidationConfigured) return;
	revalidationConfigured = true;
	configureRevalidation(
		validateLiveSessions,
		getConfig().SESSION_REVALIDATE_INTERVAL_MS,
	);
	configureAccessRevalidation(validateLiveAccess);
}

/**
 * Tie a WebSocket to its session: closed when the session is revoked, or
 * when the periodic re-check finds it expired/invalid.
 */
export function trackLiveConnection(connection: LiveConnection): () => void {
	ensureRevalidation();
	const untrack = registerConnection(connection);
	recheckAtRegistration(connection);
	return untrack;
}

/**
 * The session may have been revoked between the upgrade's auth check and
 * registration (the revocation then found nothing to close): check once
 * more now instead of waiting for the next interval.
 */
function recheckAtRegistration(connection: LiveConnection): void {
	void validateLiveSessions([connection])
		.then((verdicts) => {
			const reason = verdicts.get(connection.sessionId);
			if (reason) endSessionConnections(connection.sessionId, reason);
		})
		.catch(() => {
			// The periodic re-check covers it.
		});
}

/** AbortSignal of an SSE response that also aborts when the session ends. */
export function liveSessionSignal(
	session: Omit<LiveConnection, "close">,
	parent: AbortSignal,
): { signal: AbortSignal; release: () => void } {
	ensureRevalidation();
	const bound = sessionBoundSignal(session, parent);
	recheckAtRegistration({ ...session, close: () => {} });
	return bound;
}

/** Retention: drop sessions expired or revoked longer ago than configured. */
export async function pruneSessions(now = new Date()): Promise<void> {
	const cutoff = new Date(
		now.getTime() - getConfig().SESSION_RETENTION_DAYS * 86_400_000,
	);
	await db
		.delete(sessions)
		.where(or(lt(sessions.expiresAt, cutoff), lt(sessions.revokedAt, cutoff)));
}

/**
 * Identity of a live connection opened by `actor` for `permission`: tied
 * to its session (or API token) and re-checked against its team role.
 */
export function liveConnectionOf(
	actor: Actor,
	permission: Permission,
): Omit<LiveConnection, "close"> {
	const tokenKey = `${TOKEN_SESSION_PREFIX}${actor.tokenId ?? ""}`;
	return {
		sessionId: actor.sessionId ?? tokenKey,
		userId: actor.userId ?? tokenKey,
		access: { teamId: actor.teamId, permission },
	};
}
