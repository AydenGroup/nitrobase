import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { jobTypes, jobTypesWithOwnEvents, sessionJobTypes } from "./status";

export type EventSeverity = "info" | "warning" | "error" | "critical";
export type EventCategory =
	| "jobs"
	| "backups"
	| "monitoring"
	| "domains"
	| "updates"
	| "security";

/**
 * One notifiable event. `title`/`body` are Lingui templates rendered with
 * the event's params (every param is a string; `user` is always the
 * owner's email, `action` an audit action id rendered as its label). Adding an event = one
 * entry here + an `emitEvent` call where it happens.
 */
export interface EventDefinition {
	id: string;
	category: EventCategory;
	severity: EventSeverity;
	/** Short name in the subscription list. */
	label: MessageDescriptor;
	/** Params of `label` (job types are rendered as their label). */
	labelValues?: Record<string, string>;
	title: MessageDescriptor;
	body: MessageDescriptor;
	/** Subscribed by default when a channel is created. */
	defaultEnabled: boolean;
	/**
	 * Always delivered: never deduped or rate limited, so a flood of noisy
	 * events cannot hide it (e.g. a sign-in from a new device).
	 */
	critical?: boolean;
}

export const eventCategories: Record<EventCategory, MessageDescriptor> = {
	jobs: msg({ id: "Jobs" }),
	backups: msg({ id: "Backups" }),
	monitoring: msg({ id: "Monitoring" }),
	domains: msg({ id: "Domains & certificates" }),
	updates: msg({ id: "Updates" }),
	security: msg({ id: "Security" }),
};

export const severityOrder: EventSeverity[] = [
	"info",
	"warning",
	"error",
	"critical",
];

export const severityLabels: Record<EventSeverity, MessageDescriptor> = {
	info: msg({ id: "Info" }),
	warning: msg({ id: "Warning" }),
	error: msg({ id: "Error" }),
	critical: msg({ id: "Critical" }),
};

/** Job types that notify (interactive sessions don't). */
const notifiableJobs = Object.keys(jobTypes).filter(
	(type) => !sessionJobTypes.has(type) && !jobTypesWithOwnEvents.has(type),
);

const jobEvents: EventDefinition[] = notifiableJobs.flatMap((type) => [
	{
		id: `job.${type}.failed`,
		category: "jobs" as const,
		severity: "error" as const,
		label: msg({ id: "{job} failed" }),
		labelValues: { job: type },
		title: msg({ id: "{job} failed: {target}" }),
		body: msg({ id: "{title} failed on {server}: {error}" }),
		defaultEnabled: type !== "connection_test",
	},
	{
		id: `job.${type}.succeeded`,
		category: "jobs" as const,
		severity: "info" as const,
		label: msg({ id: "{job} succeeded" }),
		labelValues: { job: type },
		title: msg({ id: "{job} succeeded: {target}" }),
		body: msg({ id: "{title} finished on {server}." }),
		defaultEnabled: false,
	},
]);

export const notificationEvents: EventDefinition[] = [
	...jobEvents,
	{
		id: "task.failed",
		label: msg({ id: "Scheduled task failed" }),
		category: "jobs",
		severity: "error",
		title: msg({ id: "Scheduled task failed: {task} ({target})" }),
		body: msg({
			id: "{task} in {service} of {target} did not succeed ({status}): {error}",
		}),
		defaultEnabled: true,
	},
	{
		id: "task.skipped",
		label: msg({ id: "Scheduled task skipped" }),
		category: "jobs",
		severity: "warning",
		title: msg({ id: "Scheduled task skipped: {task} ({target})" }),
		body: msg({ id: "{task} of {target} did not run: {error}" }),
		defaultEnabled: false,
	},
	{
		id: "build.failed",
		label: msg({ id: "Build or deploy from Git failed" }),
		category: "jobs",
		severity: "error",
		title: msg({ id: "Build failed: {target} ({commit})" }),
		body: msg({
			id: "{target} at {commit} on {branch} did not deploy: {error}",
		}),
		defaultEnabled: true,
	},
	{
		id: "build.succeeded",
		label: msg({ id: "Build from Git deployed" }),
		category: "jobs",
		severity: "info",
		title: msg({ id: "Deployed: {target} ({commit})" }),
		body: msg({ id: "{target} now runs {commit} from {branch}: {message}" }),
		defaultEnabled: false,
	},
	{
		id: "webhook.rejected",
		label: msg({ id: "Push webhook rejected" }),
		// Not "security": those are never deduped, and anyone can send a
		// bad request to a webhook URL. Deduped per app instead.
		category: "jobs",
		severity: "warning",
		title: msg({ id: "Push webhook rejected: {target}" }),
		body: msg({
			id: "A push webhook for {target} was rejected ({reason}) from {ip}.",
		}),
		defaultEnabled: true,
	},
	{
		id: "app.update_available",
		label: msg({ id: "App update available" }),
		category: "updates",
		severity: "info",
		title: msg({ id: "Update available: {target} {to}" }),
		body: msg({
			id: "{target} runs {from}; {to} is available ({kind}). Update it from the app page.",
		}),
		defaultEnabled: true,
	},
	{
		id: "app.update_rolled_back",
		label: msg({ id: "App update rolled back" }),
		category: "updates",
		severity: "warning",
		title: msg({ id: "Update rolled back: {target}" }),
		body: msg({
			id: "Updating {target} from {from} to {to} failed and was rolled back: {error}",
		}),
		defaultEnabled: true,
	},
	{
		id: "app.update_failed",
		label: msg({ id: "App update failed without rollback" }),
		category: "updates",
		severity: "error",
		title: msg({ id: "Update failed: {target}" }),
		body: msg({
			id: "Updating {target} from {from} to {to} failed and was not rolled back: {error}",
		}),
		defaultEnabled: true,
	},
	{
		id: "backup.failed",
		label: msg({ id: "Backup failed" }),
		category: "backups",
		severity: "error",
		title: msg({ id: "Backup failed: {target}" }),
		body: msg({
			id: "The backup of {target} to {destination} failed: {error}",
		}),
		defaultEnabled: true,
	},
	{
		id: "backup.stale",
		label: msg({ id: "No recent successful backup" }),
		category: "backups",
		severity: "warning",
		title: msg({ id: "No recent backup: {target}" }),
		body: msg({
			id: "{target} has a backup schedule but no successful backup in {days} days.",
		}),
		defaultEnabled: true,
	},
	{
		id: "alert.opened",
		label: msg({ id: "Monitoring alert opened" }),
		category: "monitoring",
		severity: "warning",
		title: msg({ id: "Alert: {rule} on {target}" }),
		body: msg({
			id: "{rule}: {subject} (value {value}, threshold {threshold}).",
		}),
		defaultEnabled: true,
	},
	{
		id: "alert.resolved",
		label: msg({ id: "Monitoring alert resolved" }),
		category: "monitoring",
		severity: "info",
		title: msg({ id: "Resolved: {rule} on {target}" }),
		body: msg({ id: "{rule} for {subject} is back to normal." }),
		defaultEnabled: true,
	},
	{
		id: "server.unreachable",
		label: msg({ id: "Server unreachable" }),
		category: "monitoring",
		severity: "critical",
		title: msg({ id: "Server unreachable: {target}" }),
		body: msg({
			id: "{appName} could not reach {target} {value} times in a row.",
		}),
		defaultEnabled: true,
	},
	{
		id: "server.reachable",
		label: msg({ id: "Server reachable again" }),
		category: "monitoring",
		severity: "info",
		title: msg({ id: "Server reachable again: {target}" }),
		body: msg({ id: "{target} answers again." }),
		defaultEnabled: true,
	},
	{
		id: "cert.expiring",
		label: msg({ id: "Certificate expiring" }),
		category: "domains",
		severity: "warning",
		title: msg({ id: "Certificate expiring: {subject}" }),
		body: msg({ id: "{subject} ({target}): {detail}" }),
		defaultEnabled: true,
	},
	{
		id: "cert.error",
		label: msg({ id: "Certificate problem" }),
		category: "domains",
		severity: "error",
		title: msg({ id: "Certificate problem: {subject}" }),
		body: msg({ id: "{subject} ({target}): {detail}" }),
		defaultEnabled: true,
	},
	{
		id: "security.new_login",
		label: msg({ id: "Sign-in from a new device" }),
		category: "security",
		severity: "warning",
		title: msg({ id: "New sign-in to {appName}" }),
		body: msg({
			id: "{user} signed in from a new address or device: {ip}, {device}.",
		}),
		defaultEnabled: true,
		critical: true,
	},
	{
		id: "security.2fa_disabled",
		label: msg({ id: "2FA disabled" }),
		category: "security",
		severity: "critical",
		title: msg({ id: "Two-factor authentication disabled" }),
		body: msg({ id: "2FA was turned off for {user} from {ip}." }),
		defaultEnabled: true,
		critical: true,
	},
	{
		id: "security.secret_revealed",
		label: msg({ id: "Secret revealed" }),
		category: "security",
		severity: "warning",
		title: msg({ id: "Secret revealed: {action}" }),
		body: msg({ id: "{action} by {user} from {ip}." }),
		defaultEnabled: false,
		critical: true,
	},
];

export function getEventDefinition(id: string): EventDefinition | undefined {
	return notificationEvents.find((event) => event.id === id);
}

export function defaultSubscribedEvents(): string[] {
	return notificationEvents
		.filter((event) => event.defaultEnabled)
		.map((event) => event.id);
}
