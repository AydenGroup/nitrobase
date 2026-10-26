import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "#/features/auth/authMiddleware";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { i18nMiddleware } from "#/libs/i18n.ts";
import { resolveSessionActor } from "./membership.server";
import {
	CreateTeamSchema,
	InviteSchema,
	InviteTokenSchema,
	MemberRoleSchema,
	RenameTeamSchema,
} from "./schema";
import {
	acceptInvite,
	changeMemberRole,
	createInvite,
	createTeam,
	deleteTeam,
	getTeamContext,
	listInvites,
	listMembers,
	previewInvite,
	removeMember,
	renameTeam,
	revokeInvite,
	switchTeam,
} from "./teams.server";

/**
 * The browser's team context (switcher, role-aware UI). Account-level:
 * null for an account that belongs to no team (the UI explains it).
 */
export const getTeamContextFn = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(async ({ context }) => {
		const actor = await resolveSessionActor(context.user);
		return actor ? getTeamContext(actor) : null;
	});

/** Account-level: switch the active team (membership checked). */
export const switchTeamFn = createServerFn({ method: "POST" })
	.validator((teamId: string) => z.guid().parse(teamId))
	.middleware([authMiddleware])
	.handler(async ({ context, data }) => {
		await switchTeam(context.user, data);
		return { success: true };
	});

/** Account-level: create a team (TEAM_CREATION decides who may). */
export const createTeamFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, authMiddleware])
	.handler(async ({ context, data }) =>
		createTeam(context.user, CreateTeamSchema(context.i18n).parse(data).name),
	);

export const renameTeamFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("team.manage")])
	.handler(async ({ context, data }) => {
		await renameTeam(
			context.actor,
			RenameTeamSchema(context.i18n).parse(data).name,
		);
		return { success: true };
	});

export const deleteTeamFn = createServerFn({ method: "POST" })
	.middleware([requirePermission("team.manage")])
	.handler(async ({ context }) => {
		await deleteTeam(context.actor);
		return { success: true };
	});

export const listMembersFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("team.view")])
	.handler(async ({ context }) => listMembers(context.actor));

export const changeMemberRoleFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => MemberRoleSchema.parse(data))
	.middleware([requirePermission("members.manage")])
	.handler(async ({ context, data }) => {
		await changeMemberRole(context.actor, data.userId, data.role);
		return { success: true };
	});

export const removeMemberFn = createServerFn({ method: "POST" })
	.validator((userId: string) => z.guid().parse(userId))
	.middleware([requirePermission("members.manage")])
	.handler(async ({ context, data }) => {
		await removeMember(context.actor, data);
		return { success: true };
	});

/** Leave the active team (any member; the last owner cannot). */
export const leaveTeamFn = createServerFn({ method: "POST" })
	.middleware([requirePermission("team.view")])
	.handler(async ({ context }) => {
		if (!context.actor.userId) return { success: false };
		await removeMember(context.actor, context.actor.userId);
		return { success: true };
	});

export const listInvitesFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("members.manage")])
	.handler(async ({ context }) => listInvites(context.actor));

export const createInviteFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => InviteSchema().parse(data))
	.middleware([requirePermission("members.manage")])
	.handler(async ({ context, data }) => createInvite(context.actor, data));

export const revokeInviteFn = createServerFn({ method: "POST" })
	.validator((id: string) => z.guid().parse(id))
	.middleware([requirePermission("members.manage")])
	.handler(async ({ context, data }) => {
		await revokeInvite(context.actor, data);
		return { success: true };
	});

/**
 * Public: what an invite link offers (team, role, addressed email). The
 * token is the secret; invalid, used or expired ones are INVITE_INVALID.
 */
export const previewInviteFn = createServerFn({ method: "GET" })
	.validator((token: string) => InviteTokenSchema.parse(token))
	.handler(async ({ data }) => previewInvite(data));

/** Account-level: a signed-in account joins the team of an invite. */
export const acceptInviteFn = createServerFn({ method: "POST" })
	.validator((token: string) => InviteTokenSchema.parse(token))
	.middleware([authMiddleware])
	.handler(async ({ context, data }) => acceptInvite(context.user, data));
