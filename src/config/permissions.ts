import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { branded } from "#/libs/brand.ts";

/**
 * Permission registry (client-safe). Every server function, API route,
 * SSE stream and WebSocket upgrade names one of these ids; roles map to
 * sets of them (see `roles` below). Adding a permission = one entry here
 * plus the roles that get it.
 *
 * `scope: "instance"` permissions are never granted by a team role: they
 * belong to instance administrators (the bootstrap admin) and cover data
 * shared by every team (instance settings, the Nitrobase self-backup).
 */
export type PermissionGroup =
	| "servers"
	| "apps"
	| "databases"
	| "backups"
	| "monitoring"
	| "team"
	| "instance";

export interface PermissionDefinition {
	group: PermissionGroup;
	label: MessageDescriptor;
	scope: "team" | "instance";
	/**
	 * Permissions this one needs to be usable (deploying an app means
	 * seeing it). Granting it grants these too (`withImplied`).
	 */
	implies?: readonly string[];
}

const p = (
	group: PermissionGroup,
	label: MessageDescriptor,
	scope: "team" | "instance" = "team",
	implies?: readonly string[],
): PermissionDefinition => ({ group, label, scope, implies });

/** Team permission that needs `implies` (shorthand of `p`). */
const needs = (
	group: PermissionGroup,
	label: MessageDescriptor,
	implies: readonly string[],
): PermissionDefinition => p(group, label, "team", implies);

export const permissions = {
	"server.view": p("servers", msg({ id: "View servers and jobs" })),
	"server.manage": needs(
		"servers",
		msg({ id: "Add, edit, bootstrap and delete servers" }),
		["server.view"],
	),
	"server.terminal": needs("servers", msg({ id: "Open a server terminal" }), [
		"server.view",
	]),
	"ssh_key.view": p("servers", msg({ id: "View SSH keys" })),
	"ssh_key.manage": needs(
		"servers",
		msg({ id: "Add, edit and delete SSH keys" }),
		["ssh_key.view"],
	),
	"ssh_key.reveal": needs("servers", msg({ id: "Reveal SSH private keys" }), [
		"ssh_key.view",
	]),

	"app.view": p("apps", msg({ id: "View apps, domains and logs" })),
	"app.deploy": needs(
		"apps",
		msg({ id: "Deploy, redeploy, start, stop and restart apps" }),
		["app.view", "server.view"],
	),
	"app.delete": needs("apps", msg({ id: "Delete apps" }), ["app.view"]),
	"app.move": needs("apps", msg({ id: "Move apps between servers" }), [
		"app.view",
		"server.view",
	]),
	"app.env.edit": needs("apps", msg({ id: "Edit app environment and ports" }), [
		"app.view",
	]),
	"app.env.reveal": needs(
		"apps",
		msg({ id: "Reveal app secrets and credentials" }),
		["app.view"],
	),
	"app.terminal": needs("apps", msg({ id: "Open a container terminal" }), [
		"app.view",
	]),
	"app.database": needs(
		"apps",
		msg({ id: "Run SQL and edit database functions" }),
		["app.view"],
	),
	"app.tasks.manage": needs(
		"apps",
		msg({ id: "Create, edit and run scheduled tasks" }),
		["app.view"],
	),
	"app.source.manage": needs(
		"apps",
		msg({
			id: "Manage repository, deploy keys, build settings and push webhooks",
		}),
		["app.view"],
	),
	"app.resources.manage": needs(
		"apps",
		msg({ id: "Change app resource limits" }),
		["app.view"],
	),
	"app.update_policy.manage": needs(
		"apps",
		msg({ id: "Choose whether app updates are applied automatically" }),
		["app.view"],
	),
	"domain.manage": needs("apps", msg({ id: "Add and remove domains" }), [
		"app.view",
	]),
	"cloud_connection.view": p(
		"apps",
		msg({ id: "View cloud connections (no credentials)" }),
	),
	"cloud_connection.manage": needs(
		"apps",
		msg({ id: "Add, edit, test and delete cloud connections" }),
		["cloud_connection.view"],
	),
	"app.sync": needs(
		"apps",
		msg({
			id: "Import apps from cloud projects and export them to empty ones (cloud sync)",
		}),
		["app.deploy", "cloud_connection.view"],
	),

	"database.view": needs(
		"databases",
		msg({ id: "View databases, their connection details and links" }),
		["app.view"],
	),
	"database.manage": needs(
		"databases",
		msg({
			id: "Create, upgrade and delete databases, create databases inside them, link apps with their own login, run read-only queries",
		}),
		["database.view", "app.deploy"],
	),
	"database.write": needs(
		"databases",
		msg({
			id: "Run writing statements, create and drop logins, grant privileges, drop databases, link apps with the main login",
		}),
		["database.manage"],
	),
	"database.credentials.reveal": needs(
		"databases",
		msg({ id: "Reveal database passwords and connection strings" }),
		["database.view"],
	),

	"backup.view": p("backups", msg({ id: "View backups and destinations" })),
	"backup.create": needs("backups", msg({ id: "Back up apps now" }), [
		"backup.view",
		"app.view",
	]),
	"backup.restore": needs("backups", msg({ id: "Restore backups" }), [
		"backup.view",
		"app.view",
	]),
	"backup.delete": needs("backups", msg({ id: "Delete backups" }), [
		"backup.view",
	]),
	"backup.download": needs("backups", msg({ id: "Download backup archives" }), [
		"backup.view",
	]),
	"backup.policy.manage": needs(
		"backups",
		msg({ id: "Edit backup schedules" }),
		["backup.view", "app.view"],
	),
	"destination.manage": needs(
		"backups",
		msg({ id: "Add, edit and delete backup destinations" }),
		["backup.view"],
	),

	"monitoring.view": p("monitoring", msg({ id: "View metrics and alerts" })),
	"notification.manage": p(
		"monitoring",
		msg({ id: "Manage notification channels" }),
	),
	"audit.view": p("monitoring", msg({ id: "View the team audit log" })),

	"team.view": p("team", msg({ id: "See team members and roles" })),
	"members.manage": needs(
		"team",
		msg({ id: "Invite members and change their roles" }),
		["team.view"],
	),
	"tokens.manage": needs("team", msg({ id: "Manage team API tokens" }), [
		"team.view",
	]),
	"team.manage": needs("team", msg({ id: "Rename or delete the team" }), [
		"team.view",
	]),

	"instance.manage": p(
		"instance",
		branded(
			msg({
				id: "Instance settings and {appName} self-backup (instance administrators)",
			}),
		),
		"instance",
	),
} satisfies Record<string, PermissionDefinition>;

export type Permission = keyof typeof permissions;

export const permissionIds = Object.keys(permissions) as Permission[];

/** Permissions a team role may grant (instance ones never come from a role). */
export const teamPermissionIds = permissionIds.filter(
	(id) => permissions[id].scope === "team",
);

export function isPermission(value: unknown): value is Permission {
	return typeof value === "string" && value in permissions;
}

/** `granted` plus everything it implies (transitively). */
export function withImplied(granted: Iterable<Permission>): Permission[] {
	const out = new Set<Permission>();
	const visit = (id: Permission) => {
		if (out.has(id)) return;
		out.add(id);
		for (const implied of (permissions[id] as PermissionDefinition).implies ??
			[]) {
			if (isPermission(implied)) visit(implied);
		}
	};
	for (const id of granted) visit(id);
	return [...out];
}

/** Permissions `id` needs (transitively), excluding itself. */
export function impliedBy(id: Permission): Permission[] {
	return withImplied([id]).filter((item) => item !== id);
}

/**
 * A database is an app row (template `database`), so app endpoints reach
 * it too. On such a row an app permission stands for the database one
 * below: secrets → reveal, anything that runs code or changes what runs
 * in the container → write, everything else that acts → manage. Checked
 * by `getAppRow` (#/features/apps/apps.server.ts) for the row and for the
 * request's gate permission.
 */
const databaseAppPermissions = {
	"app.view": "database.view",
	"app.env.reveal": "database.credentials.reveal",
	"app.terminal": "database.write",
	"app.database": "database.write",
	"app.tasks.manage": "database.write",
	"app.env.edit": "database.write",
} as const satisfies Partial<Record<Permission, Permission>>;

/** Permissions of the `apps` group (plus domains) that a database row maps. */
function isAppPermission(id: Permission): boolean {
	return id.startsWith("app.") || id === "domain.manage";
}

/** The permission `permission` means on a database row. */
function databaseRowPermission(permission: Permission): Permission {
	if (!isAppPermission(permission)) return permission;
	return (
		(databaseAppPermissions as Partial<Record<Permission, Permission>>)[
			permission
		] ?? "database.manage"
	);
}

/**
 * Permissions that need MORE on a database row than on an app: a database
 * backup holds every row, so restoring it overwrites data like a write and
 * downloading it hands out the data with its credentials. Checked with
 * `databaseRowRequirements` for the row and for the request's gate.
 */
export const databaseRowExtraPermissions = {
	"backup.restore": ["database.write"],
	"backup.download": ["database.credentials.reveal"],
} as const satisfies Partial<Record<Permission, readonly Permission[]>>;

/** Every permission `permission` requires on a database row. */
export function databaseRowRequirements(permission: Permission): Permission[] {
	const extra =
		(
			databaseRowExtraPermissions as Partial<
				Record<Permission, readonly Permission[]>
			>
		)[permission] ?? [];
	return [databaseRowPermission(permission), ...extra];
}

export const permissionGroupLabels = {
	servers: msg({ id: "Servers" }),
	apps: msg({ id: "Apps" }),
	databases: msg({ id: "Databases" }),
	backups: msg({ id: "Backups" }),
	monitoring: msg({ id: "Monitoring" }),
	team: msg({ id: "Team" }),
	instance: msg({ id: "Instance" }),
} satisfies Record<PermissionGroup, MessageDescriptor>;

// ---------------------------------------------------------------------------
// Roles

export interface RoleDefinition {
	label: MessageDescriptor;
	description: MessageDescriptor;
	/** Higher ranks may manage lower ranks (an admin cannot demote an owner). */
	rank: number;
	permissions: readonly Permission[] | "all";
}

const viewPermissions = [
	"team.view",
	"server.view",
	"ssh_key.view",
	"app.view",
	"database.view",
	"backup.view",
	"monitoring.view",
	"cloud_connection.view",
] as const satisfies readonly Permission[];

const developerPermissions = [
	...viewPermissions,
	"app.deploy",
	"app.env.edit",
	"app.env.reveal",
	"app.terminal",
	"app.database",
	"app.tasks.manage",
	"app.source.manage",
	"app.update_policy.manage",
	"database.manage",
	"database.write",
	"database.credentials.reveal",
	"domain.manage",
	"backup.create",
	"backup.restore",
	"backup.download",
	"audit.view",
] as const satisfies readonly Permission[];

export const roles = {
	owner: {
		label: msg({ id: "Owner" }),
		description: msg({
			id: "Full access, including deleting the team and managing owners.",
		}),
		rank: 40,
		permissions: "all",
	},
	admin: {
		label: msg({ id: "Admin" }),
		description: msg({
			id: "Everything except deleting the team and managing owners.",
		}),
		rank: 30,
		permissions: teamPermissionIds.filter((id) => id !== "team.manage"),
	},
	developer: {
		label: msg({ id: "Developer" }),
		description: msg({
			id: "Deploys and operates apps; cannot manage servers, members or destinations.",
		}),
		rank: 20,
		permissions: developerPermissions,
	},
	viewer: {
		label: msg({ id: "Viewer" }),
		description: msg({ id: "Read-only access; secrets stay hidden." }),
		rank: 10,
		permissions: viewPermissions,
	},
} satisfies Record<string, RoleDefinition>;

export type RoleId = keyof typeof roles;

export const roleIds = Object.keys(roles) as RoleId[];

export function isRole(value: unknown): value is RoleId {
	return typeof value === "string" && value in roles;
}

/** Team permissions of a role. */
export function rolePermissions(role: RoleId): Permission[] {
	const granted = (roles[role] as RoleDefinition).permissions;
	return granted === "all" ? [...teamPermissionIds] : [...granted];
}

/** The role every new team's creator gets, and the one that can't be left empty. */
export const OWNER_ROLE: RoleId = "owner";

// ---------------------------------------------------------------------------
// API token presets (Settings → API tokens → Create)

export interface TokenPreset {
	id: string;
	label: MessageDescriptor;
	description: MessageDescriptor;
	/** Expanded with implied permissions; "all" = every team permission. */
	permissions: readonly Permission[] | "all";
}

export const tokenPresets: TokenPreset[] = [
	{
		id: "read-only",
		label: msg({ id: "Read-only" }),
		description: msg({
			id: "Lists servers, apps, jobs, backups and metrics; changes nothing.",
		}),
		permissions: viewPermissions,
	},
	{
		id: "deployer",
		label: msg({ id: "Deployer (CI)" }),
		description: msg({
			id: "Deploys, redeploys and restarts apps and follows their jobs.",
		}),
		permissions: ["app.deploy"],
	},
	{
		id: "backups",
		label: msg({ id: "Backups operator" }),
		description: msg({ id: "Starts backups and lists them." }),
		permissions: ["backup.create"],
	},
	{
		id: "admin",
		label: msg({ id: "Admin" }),
		description: msg({
			id: "Everything you can do in this team (only the permissions you hold are given).",
		}),
		permissions: "all",
	},
];

/** A preset's permissions, implied ones included. */
export function presetPermissions(preset: TokenPreset): Permission[] {
	return preset.permissions === "all"
		? [...teamPermissionIds]
		: withImplied(preset.permissions);
}
