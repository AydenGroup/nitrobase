import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { branded } from "#/libs/brand.ts";

export type AuditCategory =
	| "auth"
	| "servers"
	| "apps"
	| "backups"
	| "settings"
	| "notifications"
	| "keys"
	| "team";

export interface AuditActionMeta {
	label: MessageDescriptor;
	category: AuditCategory;
	/** Also emit this notification event (#/config/notification-events.ts). */
	event?: string;
}

const a = (
	category: AuditCategory,
	label: MessageDescriptor,
	event?: string,
): AuditActionMeta => ({ category, label, event });

/**
 * Every audited action. `audit()` only accepts these ids; the Audit page
 * labels and filters by them. Adding an action = one entry here.
 */
export const auditActions = {
	// Auth & account
	"auth.register": a("auth", msg({ id: "Account created" })),
	"auth.login": a("auth", msg({ id: "Signed in" })),
	"auth.login_failed": a("auth", msg({ id: "Sign-in failed" })),
	"auth.login_rate_limited": a("auth", msg({ id: "Sign-in rate limited" })),
	"auth.logout": a("auth", msg({ id: "Signed out" })),
	"auth.profile.update": a("auth", msg({ id: "Profile updated" })),
	"auth.password.change": a("auth", msg({ id: "Password changed" })),
	"auth.2fa.enroll_start": a("auth", msg({ id: "2FA enrollment started" })),
	"auth.2fa.enable": a("auth", msg({ id: "2FA enabled" })),
	"auth.2fa.disable": a(
		"auth",
		msg({ id: "2FA disabled" }),
		"security.2fa_disabled",
	),
	"auth.2fa.verify_failed": a("auth", msg({ id: "2FA code rejected" })),
	"auth.2fa.recovery_used": a("auth", msg({ id: "Recovery code used" })),
	"auth.2fa.recovery_regenerate": a(
		"auth",
		msg({ id: "Recovery codes regenerated" }),
	),
	"auth.session.revoke": a("auth", msg({ id: "Session revoked" })),
	"auth.session.revoke_others": a(
		"auth",
		msg({ id: "Other sessions signed out" }),
	),

	// Servers
	"server.create": a("servers", msg({ id: "Server added" })),
	"server.update": a("servers", msg({ id: "Server updated" })),
	"server.delete": a("servers", msg({ id: "Server deleted" })),
	"server.bootstrap": a("servers", msg({ id: "Server bootstrap" })),
	"server.takeover": a(
		"servers",
		branded(msg({ id: "Server taken over from another {appName} instance" })),
	),
	"server.connection_test": a("servers", msg({ id: "Connection test" })),
	"server.address.change": a("servers", msg({ id: "Server address changed" })),
	"server.host_key.reset": a("servers", msg({ id: "Host key reset" })),
	"server.orphan.wipe": a("servers", msg({ id: "Orphaned data wiped" })),
	"server.workdir.sweep": a(
		"servers",
		msg({ id: "Leftover backup staging removed" }),
	),
	"server.network.repair": a(
		"servers",
		msg({ id: "App container re-attached to the proxy network" }),
	),
	"server.terminal.open": a("servers", msg({ id: "Server terminal opened" })),
	"server.terminal.close": a("servers", msg({ id: "Server terminal closed" })),
	"server.tunnel.update": a(
		"servers",
		msg({ id: "Cloudflare Tunnel settings changed" }),
	),
	"job.cancel": a("servers", msg({ id: "Job cancelled" })),

	// Apps
	"app.create": a("apps", msg({ id: "App created" })),
	"app.delete": a("apps", msg({ id: "App deleted" })),
	"app.redeploy": a("apps", msg({ id: "App redeployed" })),
	"app.update": a("apps", msg({ id: "App version changed" })),
	"app.update_policy": a("apps", msg({ id: "App update policy changed" })),
	"app.update_bulk": a("apps", msg({ id: "Bulk app update started" })),
	"app.start": a("apps", msg({ id: "App started" })),
	"app.stop": a("apps", msg({ id: "App stopped" })),
	"app.restart": a("apps", msg({ id: "App restarted" })),
	"app.routes": a("apps", msg({ id: "Routes applied" })),
	"app.move": a("apps", msg({ id: "App moved to another server" })),
	"app.env.update": a("apps", msg({ id: "Environment changed" })),
	"app.env.reveal": a(
		"apps",
		msg({ id: "Environment revealed" }),
		"security.secret_revealed",
	),
	"app.credential.reveal": a(
		"apps",
		msg({ id: "Credential revealed" }),
		"security.secret_revealed",
	),
	"app.variable.rotate": a("apps", msg({ id: "Secret rotated" })),
	"app.variable.rotate_hook": a(
		"apps",
		msg({ id: "Rotation follow-up step run" }),
	),
	"app.compose.update": a("apps", msg({ id: "Custom compose changed" })),
	"app.compose.reveal": a(
		"apps",
		msg({ id: "Custom compose revealed" }),
		"security.secret_revealed",
	),
	"app.service_env.update": a("apps", msg({ id: "Service secrets changed" })),
	"app.build": a("apps", msg({ id: "Build and deploy started" })),
	"app.rollback": a("apps", msg({ id: "Rolled back to an earlier build" })),
	"app.source.update": a("apps", msg({ id: "Repository settings changed" })),
	"app.build_settings.update": a(
		"apps",
		msg({ id: "Build and runtime settings changed" }),
	),
	"app.build_secrets.update": a("apps", msg({ id: "Build secrets changed" })),
	"app.git_credential.create": a(
		"apps",
		msg({ id: "Repository credential created" }),
	),
	"app.webhook.update": a("apps", msg({ id: "Push webhook changed" })),
	"app.webhook.reveal": a(
		"apps",
		msg({ id: "Push webhook secret revealed" }),
		"security.secret_revealed",
	),
	"app.webhook.rotate": a("apps", msg({ id: "Push webhook secret rotated" })),
	"app.webhook.received": a("apps", msg({ id: "Push webhook accepted" })),
	"app.webhook.rejected": a("apps", msg({ id: "Push webhook rejected" })),
	"app.ports.update": a("apps", msg({ id: "Published ports changed" })),
	"app.resources.update": a("apps", msg({ id: "Resource limits changed" })),
	"app.task.create": a("apps", msg({ id: "Scheduled task created" })),
	"app.task.update": a("apps", msg({ id: "Scheduled task changed" })),
	"app.task.delete": a("apps", msg({ id: "Scheduled task deleted" })),
	"app.task.run": a("apps", msg({ id: "Scheduled task run manually" })),
	"app.domain.add": a("apps", msg({ id: "Domain added" })),
	"app.domain.remove": a("apps", msg({ id: "Domain removed" })),
	"app.domain.primary": a("apps", msg({ id: "Primary domain changed" })),
	"app.terminal.open": a("apps", msg({ id: "Container terminal opened" })),
	"app.terminal.close": a("apps", msg({ id: "Container terminal closed" })),
	"database.create": a("apps", msg({ id: "Database created" })),
	"database.upgrade": a("apps", msg({ id: "Database version changed" })),
	"database.link": a("apps", msg({ id: "Database linked to an app" })),
	"database.unlink": a("apps", msg({ id: "Database unlinked from an app" })),
	"database.credentials.reveal": a(
		"apps",
		msg({ id: "Database password revealed" }),
		"security.secret_revealed",
	),
	"database.console.write": a(
		"apps",
		msg({ id: "Database console statement (write mode)" }),
	),
	"database.db.create": a("apps", msg({ id: "Database created in a server" })),
	"database.db.drop": a("apps", msg({ id: "Database dropped from a server" })),
	"database.user.create": a("apps", msg({ id: "Database user created" })),
	"database.user.drop": a("apps", msg({ id: "Database user dropped" })),
	"database.grant": a("apps", msg({ id: "Database privileges granted" })),
	"supabase.function.create": a("apps", msg({ id: "Edge function created" })),
	"supabase.function.deploy": a("apps", msg({ id: "Edge function deployed" })),
	"supabase.function.delete": a("apps", msg({ id: "Edge function deleted" })),
	"supabase.function.invoke": a("apps", msg({ id: "Edge function invoked" })),
	"supabase.shared.create": a("apps", msg({ id: "Shared folder created" })),
	"supabase.shared.deploy": a("apps", msg({ id: "Shared folder deployed" })),
	"supabase.shared.delete": a("apps", msg({ id: "Shared folder deleted" })),
	"supabase.function.drop": a("apps", msg({ id: "Database function dropped" })),
	"supabase.sql.apply": a("apps", msg({ id: "SQL applied" })),
	"supabase.rpc.run": a("apps", msg({ id: "RPC run" })),
	"supabase.storage.repair": a(
		"apps",
		msg({ id: "Storage metadata repair started" }),
	),
	"supabase.sync.import": a("apps", msg({ id: "Supabase project imported" })),
	"appwrite.sync.import": a(
		"apps",
		msg({ id: "Appwrite Cloud project imported" }),
	),
	"supabase.sync.export": a(
		"apps",
		msg({ id: "App exported to a Supabase project" }),
	),
	"appwrite.sync.export": a(
		"apps",
		msg({ id: "App exported to an Appwrite Cloud project" }),
	),
	"cloud_connection.create": a(
		"settings",
		msg({ id: "Cloud connection added" }),
	),
	"cloud_connection.update": a(
		"settings",
		msg({ id: "Cloud connection updated" }),
	),
	"cloud_connection.delete": a(
		"settings",
		msg({ id: "Cloud connection deleted" }),
	),
	"cloud_connection.test": a(
		"settings",
		msg({ id: "Cloud connection tested" }),
	),

	// Backups
	"backup.create": a("backups", msg({ id: "Backup started" })),
	"backup.delete": a("backups", msg({ id: "Backup deleted" })),
	"backup.download": a("backups", msg({ id: "Backup downloaded" })),
	"backup.verify": a("backups", msg({ id: "Backup verified" })),
	"backup.panel": a(
		"backups",
		branded(msg({ id: "{appName} backup started" })),
	),
	"backup.restore.overwrite": a("backups", msg({ id: "Backup restored" })),
	"backup.restore.clone": a(
		"backups",
		msg({ id: "Backup restored as new app" }),
	),
	"backup.policy.save": a("backups", msg({ id: "Backup schedule saved" })),
	"backup.panel_policy.save": a(
		"backups",
		branded(msg({ id: "{appName} backup schedule saved" })),
	),
	"backup.destination.create": a("backups", msg({ id: "Destination added" })),
	"backup.destination.update": a("backups", msg({ id: "Destination updated" })),
	"backup.destination.delete": a("backups", msg({ id: "Destination deleted" })),
	"backup.destination.test": a("backups", msg({ id: "Destination tested" })),

	// Settings
	"settings.update": a("settings", msg({ id: "Setting changed" })),
	"settings.panel_route": a("settings", msg({ id: "Panel domain changed" })),
	"settings.instance_resume": a(
		"settings",
		msg({ id: "Paused instance resumed on this machine" }),
	),
	"settings.instance_upgrade": a(
		"settings",
		branded(msg({ id: "{appName} upgrade started" })),
	),
	"settings.instance_upgrade_result": a(
		"settings",
		branded(msg({ id: "{appName} upgrade finished" })),
	),
	"settings.instance_restore": a(
		"settings",
		branded(msg({ id: "{appName} restored from a self-backup" })),
	),

	// Notifications
	"notification.channel.create": a(
		"notifications",
		msg({ id: "Notification channel added" }),
	),
	"notification.channel.update": a(
		"notifications",
		msg({ id: "Notification channel updated" }),
	),
	"notification.channel.delete": a(
		"notifications",
		msg({ id: "Notification channel deleted" }),
	),
	"notification.channel.test": a(
		"notifications",
		msg({ id: "Notification channel tested" }),
	),
	"notification.channel.secret_reveal": a(
		"notifications",
		msg({ id: "Webhook signing secret revealed" }),
		"security.secret_revealed",
	),

	// SSH keys
	"ssh_key.create": a("keys", msg({ id: "SSH key added" })),
	"ssh_key.update": a("keys", msg({ id: "SSH key updated" })),
	"ssh_key.delete": a("keys", msg({ id: "SSH key deleted" })),
	"ssh_key.reveal": a(
		"keys",
		msg({ id: "SSH private key revealed" }),
		"security.secret_revealed",
	),

	// Team, members and API tokens
	"team.create": a("team", msg({ id: "Team created" })),
	"team.rename": a("team", msg({ id: "Team renamed" })),
	"team.delete": a("team", msg({ id: "Team deleted" })),
	"team.member.role": a("team", msg({ id: "Member role changed" })),
	"team.member.remove": a("team", msg({ id: "Member removed" })),
	"team.member.leave": a("team", msg({ id: "Member left the team" })),
	"team.invite.create": a("team", msg({ id: "Invite created" })),
	"team.invite.revoke": a("team", msg({ id: "Invite revoked" })),
	"team.invite.accept": a("team", msg({ id: "Invite accepted" })),
	"api_token.create": a("team", msg({ id: "API token created" })),
	"api_token.revoke": a("team", msg({ id: "API token revoked" })),
	"api.auth_failed": a(
		"team",
		msg({ id: "API request with an invalid token" }),
	),
} as const satisfies Record<string, AuditActionMeta>;

export type AuditActionId = keyof typeof auditActions;

export const auditCategories: Record<AuditCategory, MessageDescriptor> = {
	auth: msg({ id: "Account & sign-in" }),
	servers: msg({ id: "Servers" }),
	apps: msg({ id: "Apps" }),
	backups: msg({ id: "Backups" }),
	settings: msg({ id: "Settings" }),
	notifications: msg({ id: "Notifications" }),
	keys: msg({ id: "SSH keys" }),
	team: msg({ id: "Team & API tokens" }),
};

export function isAuditAction(value: string): value is AuditActionId {
	return Object.hasOwn(auditActions, value);
}
