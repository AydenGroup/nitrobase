import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
	isRole,
	OWNER_ROLE,
	type RoleDefinition,
	type RoleId,
	roles,
} from "#/config/permissions.ts";
import { appBaseUrl, getConfig } from "#/config/server.ts";
import { APP_NAME } from "#/config/shared.ts";
import { db } from "#/db/index.ts";
import { backupDestinations } from "#/db/schema/backups.ts";
import { notificationChannels } from "#/db/schema/platform.ts";
import { servers } from "#/db/schema/server.ts";
import { sshKeys } from "#/db/schema/ssh-keys.ts";
import { teamInvites, teamMembers, teams } from "#/db/schema/teams.ts";
import { users } from "#/db/schema/user.ts";
import { type Actor, assertCanAccess } from "#/features/auth/access.ts";
import { channelConfig } from "#/features/notifications/channels.server.ts";
import { notificationI18n } from "#/features/notifications/i18n.server.ts";
import { normalizeEmail } from "#/libs/email.ts";
import { audit } from "#/server/services/audit.ts";
import {
	endMemberConnections,
	endTeamConnections,
} from "#/server/services/auth/live-connections.ts";
import { sendThroughChannel } from "#/server/services/notifications/drivers.ts";
import { AppError } from "#/utils/error.ts";
import { teamDisplayName } from "./labels";
import {
	listMemberships,
	memberActor,
	setActiveTeam,
} from "./membership.server";
import type {
	CreatedInvite,
	InviteDTO,
	InvitePreview,
	MemberDTO,
	TeamContext,
	TeamSummary,
} from "./schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

const rank = (role: string): number =>
	isRole(role) ? (roles[role] as RoleDefinition).rank : 0;

/**
 * Insert a team with `ownerId` as its owner. `name` null = not named yet
 * (the personal team): shown as `defaultTeamName` in the reader's language.
 */
export async function createTeamRecord(
	tx: Executor,
	name: string | null,
	ownerId: string,
	personal = false,
): Promise<{ id: string; name: string | null }> {
	const [team] = await tx
		.insert(teams)
		.values({ name, personal })
		.returning({ id: teams.id, name: teams.name });
	await tx
		.insert(teamMembers)
		.values({ teamId: team.id, userId: ownerId, role: OWNER_ROLE });
	return team;
}

// ---------------------------------------------------------------------------
// Context, switching, creating

export async function getTeamContext(actor: Actor): Promise<TeamContext> {
	if (!actor.userId) throw new AppError("TEAM_NONE");
	const memberships = await listMemberships(actor.userId);
	const summaries: TeamSummary[] = memberships.flatMap((membership) =>
		isRole(membership.role)
			? [
					{
						id: membership.teamId,
						name: membership.teamName,
						personal: membership.personal,
						role: membership.role,
					},
				]
			: [],
	);
	const team = summaries.find((item) => item.id === actor.teamId);
	if (!team) throw new AppError("TEAM_NONE");
	return {
		team,
		teams: summaries,
		permissions: [...actor.permissions],
		instanceAdmin: actor.instanceAdmin,
		canCreateTeam: canCreateTeam(actor.instanceAdmin),
	};
}

function canCreateTeam(instanceAdmin: boolean): boolean {
	return getConfig().TEAM_CREATION === "everyone" || instanceAdmin;
}

/** Make `teamId` the browser's active team (membership required). */
export async function switchTeam(
	user: { userId: string; sessionId: string },
	teamId: string,
): Promise<void> {
	const actor = await memberActor(user.userId, teamId);
	if (!actor) throw new AppError("TEAM_NOT_FOUND");
	await setActiveTeam(user.sessionId, teamId);
}

export async function createTeam(
	user: { userId: string; sessionId: string },
	name: string,
): Promise<TeamSummary> {
	const [account] = await db
		.select({ instanceAdmin: users.instanceAdmin })
		.from(users)
		.where(eq(users.id, user.userId))
		.limit(1);
	if (!canCreateTeam(!!account?.instanceAdmin)) {
		throw new AppError("TEAM_CREATE_FORBIDDEN");
	}
	const team = await db.transaction((tx) =>
		createTeamRecord(tx, name, user.userId),
	);
	await setActiveTeam(user.sessionId, team.id);
	audit({
		userId: user.userId,
		teamId: team.id,
		action: "team.create",
		targetType: "team",
		targetId: team.id,
		meta: { name },
	});
	return { id: team.id, name, personal: false, role: OWNER_ROLE };
}

export async function renameTeam(actor: Actor, name: string): Promise<void> {
	assertCanAccess(actor, "team.manage");
	await db
		.update(teams)
		.set({ name, updatedAt: new Date() })
		.where(eq(teams.id, actor.teamId));
	audit({
		actor,
		action: "team.rename",
		targetType: "team",
		targetId: actor.teamId,
		meta: { name },
	});
}

/**
 * Delete the active team. Refused while it still has servers, SSH keys or
 * backup destinations: deleting rows would orphan running infrastructure.
 */
export async function deleteTeam(actor: Actor): Promise<void> {
	assertCanAccess(actor, "team.manage");
	const [[server], [key], [destination]] = await Promise.all([
		db
			.select({ id: servers.id })
			.from(servers)
			.where(eq(servers.teamId, actor.teamId))
			.limit(1),
		db
			.select({ id: sshKeys.id })
			.from(sshKeys)
			.where(eq(sshKeys.teamId, actor.teamId))
			.limit(1),
		db
			.select({ id: backupDestinations.id })
			.from(backupDestinations)
			.where(eq(backupDestinations.teamId, actor.teamId))
			.limit(1),
	]);
	if (server || key || destination) throw new AppError("TEAM_NOT_EMPTY");
	await db.delete(teams).where(eq(teams.id, actor.teamId));
	endTeamConnections(actor.teamId);
	audit({
		actor,
		action: "team.delete",
		targetType: "team",
		targetId: actor.teamId,
	});
}

// ---------------------------------------------------------------------------
// Members

export async function listMembers(actor: Actor): Promise<MemberDTO[]> {
	assertCanAccess(actor, "team.view");
	const rows = await db
		.select({
			userId: teamMembers.userId,
			role: teamMembers.role,
			joinedAt: teamMembers.createdAt,
			firstName: users.firstName,
			lastName: users.lastName,
			email: users.email,
			avatarUrl: users.avatarUrl,
		})
		.from(teamMembers)
		.innerJoin(users, eq(users.id, teamMembers.userId))
		.where(eq(teamMembers.teamId, actor.teamId))
		.orderBy(asc(teamMembers.createdAt));
	return rows.flatMap((row) =>
		isRole(row.role)
			? [{ ...row, role: row.role, you: row.userId === actor.userId }]
			: [],
	);
}

async function ownerCount(tx: Executor, teamId: string): Promise<number> {
	const [row] = await tx
		.select({ count: sql<number>`count(*)::int` })
		.from(teamMembers)
		.where(
			and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, OWNER_ROLE)),
		);
	return row?.count ?? 0;
}

/**
 * Rank rules: nobody grants or changes a role ranked above their own, and
 * a team keeps at least one owner.
 */
function assertCanManage(actor: Actor, targetRole: string, newRole?: RoleId) {
	assertCanAccess(actor, "members.manage");
	const own = actor.role ? rank(actor.role) : rank(OWNER_ROLE);
	if (rank(targetRole) > own || (newRole && rank(newRole) > own)) {
		throw new AppError("ROLE_NOT_ALLOWED");
	}
}

/** Close the member's live connections that their new role no longer allows. */
async function enforceLiveAccess(teamId: string, userId: string) {
	const actor = await memberActor(userId, teamId);
	endMemberConnections(teamId, userId, (permission) =>
		actor ? actor.permissions.has(permission as never) : false,
	);
}

export async function changeMemberRole(
	actor: Actor,
	userId: string,
	role: RoleId,
): Promise<void> {
	await db.transaction(async (tx) => {
		// Serialize membership changes of a team (last-owner check).
		await tx.execute(
			sql`select 1 from ${teams} where ${teams.id} = ${actor.teamId} for update`,
		);
		const [member] = await tx
			.select({ role: teamMembers.role })
			.from(teamMembers)
			.where(
				and(
					eq(teamMembers.teamId, actor.teamId),
					eq(teamMembers.userId, userId),
				),
			)
			.limit(1);
		if (!member) throw new AppError("MEMBER_NOT_FOUND");
		assertCanManage(actor, member.role, role);
		if (
			member.role === OWNER_ROLE &&
			role !== OWNER_ROLE &&
			(await ownerCount(tx, actor.teamId)) <= 1
		) {
			throw new AppError("TEAM_LAST_OWNER");
		}
		await tx
			.update(teamMembers)
			.set({ role, updatedAt: new Date() })
			.where(
				and(
					eq(teamMembers.teamId, actor.teamId),
					eq(teamMembers.userId, userId),
				),
			);
		audit({
			actor,
			action: "team.member.role",
			targetType: "user",
			targetId: userId,
			meta: { from: member.role, to: role },
		});
	});
	await enforceLiveAccess(actor.teamId, userId);
}

/** Remove a member (or leave, when `userId` is the actor). */
export async function removeMember(
	actor: Actor,
	userId: string,
): Promise<void> {
	const leaving = userId === actor.userId;
	await db.transaction(async (tx) => {
		await tx.execute(
			sql`select 1 from ${teams} where ${teams.id} = ${actor.teamId} for update`,
		);
		const [member] = await tx
			.select({ role: teamMembers.role })
			.from(teamMembers)
			.where(
				and(
					eq(teamMembers.teamId, actor.teamId),
					eq(teamMembers.userId, userId),
				),
			)
			.limit(1);
		if (!member) throw new AppError("MEMBER_NOT_FOUND");
		if (!leaving) assertCanManage(actor, member.role);
		if (
			member.role === OWNER_ROLE &&
			(await ownerCount(tx, actor.teamId)) <= 1
		) {
			throw new AppError("TEAM_LAST_OWNER");
		}
		await tx
			.delete(teamMembers)
			.where(
				and(
					eq(teamMembers.teamId, actor.teamId),
					eq(teamMembers.userId, userId),
				),
			);
		audit({
			actor,
			action: leaving ? "team.member.leave" : "team.member.remove",
			targetType: "user",
			targetId: userId,
			meta: { role: member.role },
		});
	});
	// Terminals and streams the member opened in this team close now.
	endMemberConnections(actor.teamId, userId);
	// Scheduled tasks run as their creator: theirs stop until re-enabled.
	const { disableMemberTasks } = await import(
		"#/features/tasks/tasks.server.ts"
	);
	await disableMemberTasks(actor.teamId, userId);
}

// ---------------------------------------------------------------------------
// Invites

const hashToken = (token: string) =>
	createHash("sha256").update(token).digest("hex");

function inviteLink(token: string): string | null {
	const base = appBaseUrl();
	return base ? `${base}/invite/${token}` : null;
}

function toInviteDTO(
	row: typeof teamInvites.$inferSelect,
	invitedBy: string | null,
): InviteDTO {
	return {
		id: row.id,
		email: row.email,
		role: isRole(row.role) ? row.role : "viewer",
		expiresAt: row.expiresAt,
		createdAt: row.createdAt,
		invitedBy,
	};
}

export async function listInvites(actor: Actor): Promise<InviteDTO[]> {
	assertCanAccess(actor, "members.manage");
	const rows = await db
		.select({ invite: teamInvites, invitedBy: users.email })
		.from(teamInvites)
		.leftJoin(users, eq(users.id, teamInvites.createdBy))
		.where(
			and(
				eq(teamInvites.teamId, actor.teamId),
				isNull(teamInvites.acceptedAt),
				isNull(teamInvites.revokedAt),
				gt(teamInvites.expiresAt, new Date()),
			),
		)
		.orderBy(desc(teamInvites.createdAt));
	return rows.map((row) => toInviteDTO(row.invite, row.invitedBy));
}

/**
 * Create an invite link (token shown once). With an email and an enabled
 * email channel in the team (and APP_URL for an absolute link), the link
 * is also mailed; otherwise the inviter copies it.
 */
export async function createInvite(
	actor: Actor,
	input: { email?: string; role: RoleId; sendEmail: boolean },
): Promise<CreatedInvite> {
	assertCanManage(actor, "viewer", input.role);
	const email = input.email ? normalizeEmail(input.email) : null;
	if (email) {
		const [existing] = await db
			.select({ id: users.id })
			.from(teamMembers)
			.innerJoin(users, eq(users.id, teamMembers.userId))
			.where(
				and(
					eq(teamMembers.teamId, actor.teamId),
					sql`lower(${users.email}) = lower(${email})`,
				),
			)
			.limit(1);
		if (existing) throw new AppError("MEMBER_ALREADY");
	}
	const token = randomBytes(32).toString("base64url");
	const [row] = await db
		.insert(teamInvites)
		.values({
			teamId: actor.teamId,
			email,
			role: input.role,
			tokenHash: hashToken(token),
			createdBy: actor.userId,
			expiresAt: new Date(
				Date.now() + getConfig().INVITE_TTL_HOURS * 3_600_000,
			),
		})
		.returning();
	const link = inviteLink(token);
	let delivery: CreatedInvite["email"] = "skipped";
	if (email && link && input.sendEmail) {
		delivery = await mailInvite(actor, email, link, input.role).catch(
			(error) => {
				console.warn("[teams] invite email failed", error);
				return "failed" as const;
			},
		);
	}
	audit({
		actor,
		action: "team.invite.create",
		targetType: "invite",
		targetId: row.id,
		meta: { email, role: input.role, emailed: delivery },
	});
	const [inviter] = actor.userId
		? await db
				.select({ email: users.email })
				.from(users)
				.where(eq(users.id, actor.userId))
				.limit(1)
		: [];
	return {
		invite: toInviteDTO(row, inviter?.email ?? null),
		token,
		link,
		email: delivery,
	};
}

/** Send the link through the team's first enabled email channel. */
async function mailInvite(
	actor: Actor,
	to: string,
	link: string,
	role: RoleId,
): Promise<CreatedInvite["email"]> {
	const [channel] = await db
		.select()
		.from(notificationChannels)
		.where(
			and(
				eq(notificationChannels.teamId, actor.teamId),
				eq(notificationChannels.type, "email"),
				eq(notificationChannels.enabled, true),
			),
		)
		.orderBy(asc(notificationChannels.createdAt))
		.limit(1);
	if (!channel) return "skipped";
	const [team] = await db
		.select({ name: teams.name })
		.from(teams)
		.where(eq(teams.id, actor.teamId))
		.limit(1);
	const i18n = notificationI18n();
	const config = getConfig();
	const { config: settings } = channelConfig(channel);
	await sendThroughChannel(
		"email",
		{ ...settings, to },
		{
			eventId: "team.invite",
			severity: "info",
			title: i18n._("You are invited to the team “{team}” on {appName}", {
				appName: APP_NAME,
				team: teamDisplayName(i18n, team?.name),
			}),
			body: i18n._(
				"Open the link to join the team as {role}. It expires in {hours} hours.",
				{
					role: i18n._(roles[role].label),
					hours: config.INVITE_TTL_HOURS,
				},
			),
			url: link,
			at: new Date(),
			fields: [],
		},
		{
			timeoutMs: config.NOTIFY_TIMEOUT_MS,
			telegramApiUrl: config.TELEGRAM_API_URL,
			now: new Date(),
		},
	);
	return "sent";
}

export async function revokeInvite(actor: Actor, id: string): Promise<void> {
	assertCanAccess(actor, "members.manage");
	const revoked = await db
		.update(teamInvites)
		.set({ revokedAt: new Date() })
		.where(
			and(
				eq(teamInvites.id, id),
				eq(teamInvites.teamId, actor.teamId),
				isNull(teamInvites.acceptedAt),
			),
		)
		.returning({ id: teamInvites.id });
	if (!revoked[0]) throw new AppError("INVITE_INVALID");
	audit({
		actor,
		action: "team.invite.revoke",
		targetType: "invite",
		targetId: id,
	});
}

/** A valid invite found by its token (checked again when consumed). */
export interface InviteClaim {
	id: string;
	teamId: string;
	role: RoleId;
	email: string | null;
	tokenHash: string;
}

export async function findInvite(token: string): Promise<InviteClaim> {
	const [row] = await db
		.select()
		.from(teamInvites)
		.where(
			and(
				eq(teamInvites.tokenHash, hashToken(token)),
				isNull(teamInvites.acceptedAt),
				isNull(teamInvites.revokedAt),
				gt(teamInvites.expiresAt, new Date()),
			),
		)
		.limit(1);
	if (!row || !isRole(row.role)) throw new AppError("INVITE_INVALID");
	return {
		id: row.id,
		teamId: row.teamId,
		role: row.role,
		email: row.email,
		tokenHash: row.tokenHash,
	};
}

export async function previewInvite(token: string): Promise<InvitePreview> {
	const claim = await findInvite(token);
	const [row] = await db
		.select({
			name: teams.name,
			expiresAt: teamInvites.expiresAt,
			firstName: users.firstName,
			lastName: users.lastName,
		})
		.from(teamInvites)
		.innerJoin(teams, eq(teams.id, teamInvites.teamId))
		.leftJoin(users, eq(users.id, teamInvites.createdBy))
		.where(eq(teamInvites.id, claim.id))
		.limit(1);
	const inviter = `${row?.firstName ?? ""} ${row?.lastName ?? ""}`.trim();
	return {
		teamName: row?.name ?? null,
		// A name only (never the inviter's email: the link may be forwarded).
		inviterName: inviter || null,
		role: claim.role,
		email: claim.email,
		expiresAt: row?.expiresAt ?? new Date(),
	};
}

/**
 * Atomically use an invite for `user` (inside the caller's transaction):
 * the invite must still be open and, when addressed, match the email.
 */
export async function consumeInvite(
	tx: Executor,
	claim: InviteClaim,
	user: { id: string; email: string },
): Promise<void> {
	if (claim.email && normalizeEmail(user.email) !== claim.email) {
		throw new AppError("INVITE_EMAIL_MISMATCH");
	}
	const [used] = await tx
		.update(teamInvites)
		.set({ acceptedAt: new Date(), acceptedBy: user.id })
		.where(
			and(
				eq(teamInvites.id, claim.id),
				eq(teamInvites.tokenHash, claim.tokenHash),
				isNull(teamInvites.acceptedAt),
				isNull(teamInvites.revokedAt),
				gt(teamInvites.expiresAt, new Date()),
			),
		)
		.returning({ id: teamInvites.id });
	if (!used) throw new AppError("INVITE_INVALID");
	const inserted = await tx
		.insert(teamMembers)
		.values({ teamId: claim.teamId, userId: user.id, role: claim.role })
		.onConflictDoNothing()
		.returning({ teamId: teamMembers.teamId });
	if (!inserted[0]) throw new AppError("MEMBER_ALREADY");
}

/** A signed-in account accepts an invite and switches to that team. */
export async function acceptInvite(
	user: { userId: string; sessionId: string; email: string },
	token: string,
): Promise<{ teamId: string }> {
	const claim = await findInvite(token);
	await db.transaction((tx) =>
		consumeInvite(tx, claim, { id: user.userId, email: user.email }),
	);
	await setActiveTeam(user.sessionId, claim.teamId);
	audit({
		userId: user.userId,
		teamId: claim.teamId,
		action: "team.invite.accept",
		targetType: "invite",
		targetId: claim.id,
		meta: { role: claim.role },
	});
	return { teamId: claim.teamId };
}

export type { RoleId };
