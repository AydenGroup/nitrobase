import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { AppStatus, DomainCheckStatus } from "#/features/apps/schema.ts";
import type { DeliveryStatus, ReleaseStatus } from "#/features/git/schema.ts";
import type {
	DeploymentStatus,
	ServerStatus,
} from "#/features/servers/schema.ts";
import { branded } from "#/libs/brand.ts";
import type { StatusTone } from "#/theme/tokens.ts";
import type { BACKUP_STATUSES } from "./enums.ts";
import { lookup } from "./labels.ts";

export interface StatusMeta {
	label: MessageDescriptor;
	tone: StatusTone;
	/** Pulsing dot while something is in progress (polling, locked actions). */
	busy?: boolean;
	/**
	 * Left behind by a job that died with the process: boot recovery
	 * moves these rows to `error`. Busy statuses count too.
	 */
	interruptible?: boolean;
	/**
	 * Every long-running service of the app should be up: a stopped one is
	 * reported (`container_exited` alert, degraded status). Off while the
	 * owner stopped the app or a job is changing it.
	 */
	live?: boolean;
}

/** Whether `status` is in progress in `registry` (polling, locks). */
export function isBusy(
	registry: Record<string, StatusMeta>,
	status: string | null | undefined,
): boolean {
	return !!lookup(registry, status)?.busy;
}

/** Statuses boot recovery resets: in progress, or waiting on a lost job. */
export function interruptibleStatuses<K extends string>(
	registry: Record<K, StatusMeta>,
): K[] {
	return (Object.keys(registry) as K[]).filter(
		(key) => registry[key].busy || registry[key].interruptible,
	);
}

type ServerNextAction = "test" | "bootstrap" | "edit" | null;

export interface ServerStatusMeta extends StatusMeta {
	/** Next-step hint shown on the server page. */
	hint: MessageDescriptor;
	/** Call to action the UI renders for this status. */
	action: ServerNextAction;
}

/**
 * Server status model: Pending → (test) → Unreachable | Reachable →
 * (bootstrap) → Bootstrapping → Ready | Error.
 */
export const serverStatuses: Record<ServerStatus, ServerStatusMeta> = {
	pending: {
		label: msg({ id: "Pending" }),
		tone: "neutral",
		hint: branded(
			msg({
				id: "Not checked yet. Test the connection to make sure {appName} can reach this server.",
			}),
		),
		action: "test",
	},
	unreachable: {
		label: msg({ id: "Unreachable" }),
		tone: "danger",
		hint: branded(
			msg({
				id: "{appName} could not connect. Check the host, port, credentials and firewall, then test again.",
			}),
		),
		action: "edit",
	},
	reachable: {
		label: msg({ id: "Reachable" }),
		tone: "info",
		hint: msg({
			id: "Connected, but not bootstrapped yet. Bootstrap installs Docker and Traefik so you can deploy apps.",
		}),
		action: "bootstrap",
	},
	bootstrapping: {
		label: msg({ id: "Bootstrapping" }),
		tone: "progress",
		busy: true,
		hint: msg({
			id: "Installing Docker and Traefik. Follow the job log for progress.",
		}),
		action: null,
	},
	ready: {
		label: msg({ id: "Ready" }),
		tone: "success",
		hint: msg({
			id: "Docker and Traefik are running. You can deploy apps to this server.",
		}),
		action: null,
	},
	error: {
		label: msg({ id: "Error" }),
		tone: "danger",
		hint: msg({
			id: "The last bootstrap failed. Read the job log, fix the cause and bootstrap again.",
		}),
		action: "bootstrap",
	},
};

/**
 * The built-in local server (the machine running Nitrobase) is optional:
 * until bootstrapped it is not "pending a test" but simply unused.
 */
const localServerStatuses: Partial<Record<ServerStatus, ServerStatusMeta>> = {
	pending: {
		label: msg({ id: "Local — not bootstrapped" }),
		tone: "neutral",
		hint: branded(
			msg({
				id: "This is the machine {appName} runs on. Bootstrap it to deploy apps here as well, or ignore it if you only deploy to your VPS servers.",
			}),
		),
		action: "bootstrap",
	},
	reachable: {
		label: msg({ id: "Local — not bootstrapped" }),
		tone: "neutral",
		hint: branded(
			msg({
				id: "This is the machine {appName} runs on. Bootstrap it to deploy apps here as well, or ignore it if you only deploy to your VPS servers.",
			}),
		),
		action: "bootstrap",
	},
};

/** Status meta of a server (the local server has its own wording). */
export function serverStatusMeta(server: {
	status: ServerStatus;
	isDefault?: boolean;
}): ServerStatusMeta {
	return (
		(server.isDefault ? localServerStatuses[server.status] : undefined) ??
		serverStatuses[server.status]
	);
}

/** Whether a server is optional and unused (counts as "not in use", not "not ready"). */
export function isUnusedLocalServer(server: {
	status: ServerStatus;
	isDefault?: boolean;
}): boolean {
	return !!server.isDefault && !!localServerStatuses[server.status];
}

/** Deployment/job status registry. */
export const deploymentStatuses: Record<DeploymentStatus, StatusMeta> = {
	pending: { label: msg({ id: "Pending" }), tone: "neutral" },
	running: { label: msg({ id: "Running" }), tone: "progress", busy: true },
	success: { label: msg({ id: "Success" }), tone: "success" },
	failed: { label: msg({ id: "Failed" }), tone: "danger" },
};

/** App status registry. */
export const appStatuses: Record<AppStatus, StatusMeta> = {
	// Created, its first job not started yet. Not busy: if that job never
	// starts, the owner must still be able to redeploy.
	pending: {
		label: msg({ id: "Pending" }),
		tone: "neutral",
		interruptible: true,
	},
	deploying: { label: msg({ id: "Deploying" }), tone: "progress", busy: true },
	running: { label: msg({ id: "Running" }), tone: "success", live: true },
	stopped: { label: msg({ id: "Stopped" }), tone: "neutral" },
	error: { label: msg({ id: "Error" }), tone: "danger" },
	deleting: { label: msg({ id: "Deleting" }), tone: "warning", busy: true },
};

/**
 * Shown instead of a `live` status (Running) while some long-running
 * services of the app are not running (BUG-015): not stored, derived from
 * the latest monitoring samples.
 */
export const degradedAppStatus: StatusMeta = {
	label: msg({ id: "Partially running" }),
	tone: "warning",
};

/** Status to show for an app, given its services that are not running. */
export function appDisplayStatus(
	status: AppStatus,
	notRunning: readonly string[] = [],
): StatusMeta {
	const meta = appStatuses[status];
	return meta?.live && notRunning.length > 0 ? degradedAppStatus : meta;
}

/** DNS/certificate check status registry. */
export const domainCheckStatuses: Record<DomainCheckStatus, StatusMeta> = {
	unknown: { label: msg({ id: "Not checked" }), tone: "neutral" },
	ok: { label: msg({ id: "OK" }), tone: "success" },
	warning: { label: msg({ id: "Warning" }), tone: "warning" },
	error: { label: msg({ id: "Error" }), tone: "danger" },
};

/** Job type registry: title shown in job lists and the log drawer. */
export const jobTypes = {
	bootstrap: msg({ id: "Bootstrap server" }),
	connection_test: msg({ id: "Test connection" }),
	terminal: msg({ id: "Terminal session" }),
	app_deploy: msg({ id: "Deploy app" }),
	app_redeploy: msg({ id: "Redeploy app" }),
	app_update: msg({ id: "Change version" }),
	app_start: msg({ id: "Start" }),
	app_stop: msg({ id: "Stop" }),
	app_restart: msg({ id: "Restart" }),
	app_rotate_hook: msg({ id: "Rotation follow-up step" }),
	app_delete: msg({ id: "Delete app" }),
	app_routes: msg({ id: "Update routes" }),
	app_terminal: msg({ id: "Container terminal" }),
	orphan_wipe: msg({ id: "Wipe orphaned data" }),
	panel_route: msg({ id: "Panel domain" }),
	app_backup: msg({ id: "Backup" }),
	app_restore: msg({ id: "Restore" }),
	app_move: msg({ id: "Move app" }),
	tunnel: msg({ id: "Cloudflare Tunnel" }),
	panel_backup: branded(msg({ id: "{appName} backup" })),
	app_recover: msg({ id: "Recover services" }),
	backup_verify: msg({ id: "Verify backup" }),
	workdir_sweep: msg({ id: "Clean up leftovers" }),
	network_migration: msg({ id: "Proxy network update" }),
	app_task: msg({ id: "Scheduled task" }),
	app_build: msg({ id: "Build and deploy" }),
	app_rollback: msg({ id: "Roll back" }),
	database_link: msg({ id: "Link database" }),
	database_unlink: msg({ id: "Unlink database" }),
	panel_upgrade: branded(msg({ id: "Upgrade {appName}" })),
	supabase_import: msg({ id: "Import from Supabase" }),
	appwrite_import: msg({ id: "Import from Appwrite Cloud" }),
	supabase_export: msg({ id: "Export to Supabase" }),
	supabase_storage_repair: msg({ id: "Repair storage metadata" }),
	appwrite_export: msg({ id: "Export to Appwrite Cloud" }),
} satisfies Record<string, MessageDescriptor>;

/** Every job kind (the registry above is the source of truth). */
export type JobType = keyof typeof jobTypes;

/** Translated title of a job kind (stored as text); undefined if unknown. */
export function jobTypeLabel(i18n: I18n, type: string): string | undefined {
	const label = lookup(jobTypes, type);
	return label ? i18n._(label) : undefined;
}

/** Interactive session job types (not lockable work; hidden from "busy"). */
export const sessionJobTypes = new Set(["terminal", "app_terminal"]);

/**
 * Job types that notify through their own catalog events instead of the
 * generic `job.<type>.*` ones (scheduled tasks: `task.failed`).
 */
export const jobTypesWithOwnEvents = new Set(["app_task", "app_build"]);

/** Scheduled task run status registry (M8). */
export const taskRunStatuses: Record<
	"running" | "success" | "failed" | "skipped" | "timeout" | "oom" | "killed",
	StatusMeta
> = {
	running: { label: msg({ id: "Running" }), tone: "progress", busy: true },
	success: { label: msg({ id: "Success" }), tone: "success" },
	failed: { label: msg({ id: "Failed" }), tone: "danger" },
	skipped: { label: msg({ id: "Skipped" }), tone: "warning" },
	timeout: { label: msg({ id: "Timed out" }), tone: "danger" },
	oom: { label: msg({ id: "Out of memory" }), tone: "danger" },
	killed: { label: msg({ id: "Killed" }), tone: "danger" },
};

/** Git app build (release) status registry (R2 M1). */
export const releaseStatuses: Record<ReleaseStatus, StatusMeta> = {
	building: { label: msg({ id: "Building" }), tone: "progress", busy: true },
	ready: { label: msg({ id: "Image kept" }), tone: "neutral" },
	failed: { label: msg({ id: "Failed" }), tone: "danger" },
	pruned: { label: msg({ id: "Image removed" }), tone: "neutral" },
};

/** The release whose image runs now. */
export const liveReleaseStatus: StatusMeta = {
	label: msg({ id: "Live" }),
	tone: "success",
};

/** Push webhook delivery status registry. */
export const deliveryStatuses: Record<DeliveryStatus, StatusMeta> = {
	queued: { label: msg({ id: "Queued" }), tone: "progress", busy: true },
	deployed: { label: msg({ id: "Build started" }), tone: "success" },
	superseded: { label: msg({ id: "Superseded" }), tone: "neutral" },
	ignored: { label: msg({ id: "Ignored" }), tone: "neutral" },
	rejected: { label: msg({ id: "Rejected" }), tone: "danger" },
	duplicate: { label: msg({ id: "Duplicate" }), tone: "neutral" },
	rate_limited: { label: msg({ id: "Rate limited" }), tone: "warning" },
	failed: { label: msg({ id: "Failed" }), tone: "danger" },
};

/** Backup run status registry. */
export const backupStatuses: Record<
	(typeof BACKUP_STATUSES)[number],
	StatusMeta
> = {
	running: { label: msg({ id: "Running" }), tone: "progress", busy: true },
	success: { label: msg({ id: "Success" }), tone: "success" },
	failed: { label: msg({ id: "Failed" }), tone: "danger" },
	corrupt: { label: msg({ id: "Corrupt" }), tone: "danger" },
};
