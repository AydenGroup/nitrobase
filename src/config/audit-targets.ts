import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/**
 * Kinds of audit targets (client-safe registry): the label of the target
 * badge on the audit page. The server resolves target ids of these kinds
 * to names (`resolveTargetNames`). An unknown kind shows its raw id.
 */
export const auditTargetTypes = {
	app: msg({ id: "App" }),
	server: msg({ id: "Server" }),
	backup: msg({ id: "Backup" }),
	backup_destination: msg({ id: "Destination" }),
	cloud_connection: msg({ id: "Cloud connection" }),
	notification_channel: msg({ id: "Notification channel" }),
	ssh_key: msg({ id: "SSH key" }),
	api_token: msg({ id: "API token" }),
	team: msg({ id: "Team" }),
	user: msg({ id: "User" }),
	invite: msg({ id: "Invite" }),
	session: msg({ id: "Session" }),
	deployment: msg({ id: "Job" }),
	setting: msg({ id: "Setting" }),
} satisfies Record<string, MessageDescriptor>;

export type AuditTargetType = keyof typeof auditTargetTypes;

export function isAuditTargetType(value: unknown): value is AuditTargetType {
	return typeof value === "string" && value in auditTargetTypes;
}
