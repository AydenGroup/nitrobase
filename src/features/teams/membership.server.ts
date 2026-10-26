import { and, asc, desc, eq } from "drizzle-orm";
import { isRole, type Permission } from "#/config/permissions.ts";
import { db } from "#/db/index.ts";
import { teamMembers, teams } from "#/db/schema/teams.ts";
import { sessions, users } from "#/db/schema/user.ts";
import { type Actor, memberPermissions } from "#/features/auth/access.ts";

export interface Membership {
	teamId: string;
	teamName: string | null;
	personal: boolean;
	role: string;
}

/** Teams of a user, personal team first, then oldest membership first. */
export async function listMemberships(userId: string): Promise<Membership[]> {
	return db
		.select({
			teamId: teamMembers.teamId,
			teamName: teams.name,
			personal: teams.personal,
			role: teamMembers.role,
		})
		.from(teamMembers)
		.innerJoin(teams, eq(teams.id, teamMembers.teamId))
		.where(eq(teamMembers.userId, userId))
		.orderBy(desc(teams.personal), asc(teamMembers.createdAt));
}

/** Role of `userId` in `teamId`, or null when not a member. */
async function memberRole(
	teamId: string,
	userId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ role: teamMembers.role })
		.from(teamMembers)
		.where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
		.limit(1);
	return row?.role ?? null;
}

async function isInstanceAdmin(userId: string): Promise<boolean> {
	const [row] = await db
		.select({ admin: users.instanceAdmin })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return !!row?.admin;
}

/** Actor of a member in a team; null when not a member (or unknown role). */
export async function memberActor(
	userId: string,
	teamId: string,
	extra: Pick<Actor, "via" | "sessionId" | "tokenId"> = { via: "session" },
): Promise<Actor | null> {
	const [role, instanceAdmin] = await Promise.all([
		memberRole(teamId, userId),
		isInstanceAdmin(userId),
	]);
	if (!role || !isRole(role)) return null;
	return {
		userId,
		teamId,
		role,
		permissions: memberPermissions(role, instanceAdmin),
		instanceAdmin,
		...extra,
	};
}

/**
 * Actor of a signed-in browser: the session's active team when the user is
 * still a member, else their first team (stored back on the session).
 * Null when the user belongs to no team.
 */
export async function resolveSessionActor(session: {
	userId: string;
	sessionId: string;
}): Promise<Actor | null> {
	const [row] = await db
		.select({ activeTeamId: sessions.activeTeamId })
		.from(sessions)
		.where(eq(sessions.id, session.sessionId))
		.limit(1);
	const extra = { via: "session" as const, sessionId: session.sessionId };
	if (row?.activeTeamId) {
		const actor = await memberActor(session.userId, row.activeTeamId, extra);
		if (actor) return actor;
	}
	const [first] = await listMemberships(session.userId);
	if (!first) return null;
	await setActiveTeam(session.sessionId, first.teamId);
	return memberActor(session.userId, first.teamId, extra);
}

export async function setActiveTeam(
	sessionId: string,
	teamId: string,
): Promise<void> {
	await db
		.update(sessions)
		.set({ activeTeamId: teamId })
		.where(eq(sessions.id, sessionId));
}

/**
 * Whether a live connection opened by `userId` in `teamId` for
 * `permission` may stay open (membership and role re-checked).
 */
export async function stillAllowed(
	userId: string,
	teamId: string,
	permission: Permission,
): Promise<boolean> {
	const actor = await memberActor(userId, teamId);
	return !!actor && actor.permissions.has(permission);
}
