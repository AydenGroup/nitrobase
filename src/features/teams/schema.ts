import type { I18n } from "@lingui/core";
import { z } from "zod";
import { isRole, type Permission, type RoleId } from "#/config/permissions.ts";
import { emailSchema } from "#/libs/email.ts";

const TeamNameSchema = (i18n: I18n) =>
	z
		.string()
		.trim()
		.min(1, i18n._("Enter a team name"))
		.max(80, i18n._("Use at most 80 characters"));

const RoleSchema = z.string().refine(isRole) as unknown as z.ZodType<
	RoleId,
	string
>;

export const CreateTeamSchema = (i18n: I18n) =>
	z.object({ name: TeamNameSchema(i18n) });

export const RenameTeamSchema = (i18n: I18n) =>
	z.object({ name: TeamNameSchema(i18n) });

export const InviteSchema = () =>
	z.object({
		/** Empty: anyone holding the link may join. */
		email: z
			.union([z.literal(""), emailSchema()])
			.optional()
			.transform((value) => value || undefined),
		role: RoleSchema,
		/** Send the link with the team's email channel when one is set up. */
		sendEmail: z.boolean().default(true),
	});

// z.guid(): any 8-4-4-4-12 hex id (accounts created outside the app may
// not carry RFC 4122 version bits); the DB still checks existence.
export const MemberRoleSchema = z.object({
	userId: z.guid(),
	role: RoleSchema,
});

export const InviteTokenSchema = z
	.string()
	.regex(/^[A-Za-z0-9_-]{20,100}$/, "invalid invite");

export interface TeamSummary {
	id: string;
	/** null = never named (`teamDisplayName`). */
	name: string | null;
	personal: boolean;
	role: RoleId;
}

/** The signed-in browser's team context (sidebar switcher, role-aware UI). */
export interface TeamContext {
	team: TeamSummary;
	teams: TeamSummary[];
	permissions: Permission[];
	instanceAdmin: boolean;
	/** Whether this account may create more teams (TEAM_CREATION). */
	canCreateTeam: boolean;
}

export interface MemberDTO {
	userId: string;
	firstName: string;
	lastName: string;
	email: string;
	avatarUrl: string | null;
	role: RoleId;
	joinedAt: Date;
	you: boolean;
}

export interface InviteDTO {
	id: string;
	email: string | null;
	role: RoleId;
	expiresAt: Date;
	createdAt: Date;
	invitedBy: string | null;
}

export interface CreatedInvite {
	invite: InviteDTO;
	/** Shown once: the raw token (the link is built from it). */
	token: string;
	/** Absolute link when APP_URL is set, else null (the page builds it). */
	link: string | null;
	/** Email delivery outcome: sent, skipped (no channel / APP_URL / address) or failed. */
	email: "sent" | "skipped" | "failed";
}

/** What an invite link shows before joining. */
export interface InvitePreview {
	/** null = never named (`teamDisplayName`). */
	teamName: string | null;
	/** Display name of the member who created the invite. */
	inviterName: string | null;
	role: RoleId;
	email: string | null;
	expiresAt: Date;
}
