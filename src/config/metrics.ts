import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { StatusTone } from "#/theme/tokens.ts";

/** History ranges offered by the monitoring charts (id → seconds). */
export const metricRanges = [
	{ id: "1h", seconds: 60 * 60, label: msg({ id: "1 hour" }) },
	{ id: "24h", seconds: 24 * 60 * 60, label: msg({ id: "24 hours" }) },
	{ id: "7d", seconds: 7 * 24 * 60 * 60, label: msg({ id: "7 days" }) },
] as const satisfies readonly {
	id: string;
	seconds: number;
	label: MessageDescriptor;
}[];

export const metricRangeIds = [
	"1h",
	"24h",
	"7d",
] as const satisfies readonly (typeof metricRanges)[number]["id"][];

export function rangeSeconds(id: (typeof metricRangeIds)[number]): number {
	return metricRanges.find((range) => range.id === id)?.seconds ?? 3600;
}

export interface AlertRuleMeta {
	label: MessageDescriptor;
	/** Short line under the title; `{subject}` `{value}` `{threshold}` params. */
	describe: MessageDescriptor;
	tone: StatusTone;
}

/**
 * UI metadata of alert rules (server registry:
 * #/server/services/monitoring/alert-rules.ts). Unknown ids render with
 * their id.
 */
export type AlertRuleId =
	| "disk_usage"
	| "memory_usage"
	| "restart_loop"
	| "container_unhealthy"
	| "container_exited"
	| "container_oom"
	| "network_flap"
	| "server_unreachable";

export const alertRuleMeta = {
	disk_usage: {
		label: msg({ id: "Disk almost full" }),
		describe: msg({
			id: "{subject} is {value}% full (threshold {threshold}%)",
		}),
		tone: "warning",
	},
	memory_usage: {
		label: msg({ id: "High memory usage" }),
		describe: msg({ id: "Memory at {value}% (threshold {threshold}%)" }),
		tone: "warning",
	},
	restart_loop: {
		label: msg({ id: "Restart loop" }),
		describe: msg({
			id: "{subject} restarted {value} times in the restart-loop window",
		}),
		tone: "danger",
	},
	container_unhealthy: {
		label: msg({ id: "Unhealthy container" }),
		describe: msg({ id: "{subject} fails its health check" }),
		tone: "danger",
	},
	container_exited: {
		label: msg({ id: "Service stopped" }),
		describe: msg({
			id: "{subject} stopped (exit code {value}) while its app should be running",
		}),
		tone: "danger",
	},
	container_oom: {
		label: msg({ id: "Killed: out of memory" }),
		describe: msg({
			id: "{subject} was killed for using more memory than its limit",
		}),
		tone: "danger",
	},
	network_flap: {
		label: msg({ id: "Proxy network keeps dropping" }),
		describe: msg({
			id: "{subject} needed the same proxy network repair on {value} checks in a row: automatic repairs are paused until it stays attached. Redeploy the app, or check what detaches it.",
		}),
		tone: "warning",
	},
	server_unreachable: {
		label: msg({ id: "Server unreachable" }),
		describe: msg({
			id: "Metrics collection failed {value} times in a row",
		}),
		tone: "danger",
	},
} satisfies Record<AlertRuleId, AlertRuleMeta>;

/** Docker health / state values shown for a container. */
export type ContainerHealth =
	| "healthy"
	| "unhealthy"
	| "starting"
	| "running"
	| "restarting"
	| "exited"
	| "dead"
	| "paused"
	| "created";

/**
 * Container states of a service that is not running and will not come
 * back by itself (`restarting` is the restart-loop rule's).
 */
export const STOPPED_CONTAINER_STATES: ReadonlySet<string> = new Set([
	"exited",
	"dead",
] satisfies ContainerHealth[]);

/** Container health → status tone. */
export const containerHealthTones = {
	healthy: "success",
	unhealthy: "danger",
	starting: "progress",
	running: "success",
	restarting: "warning",
	exited: "neutral",
	dead: "danger",
	paused: "neutral",
	created: "neutral",
} satisfies Record<ContainerHealth, StatusTone>;

export const containerHealthLabels = {
	healthy: msg({ id: "Healthy" }),
	unhealthy: msg({ id: "Unhealthy" }),
	starting: msg({ id: "Starting" }),
	running: msg({ id: "Running" }),
	restarting: msg({ id: "Restarting" }),
	exited: msg({ id: "Exited" }),
	dead: msg({ id: "Dead" }),
	paused: msg({ id: "Paused" }),
	created: msg({ id: "Created" }),
} satisfies Record<ContainerHealth, MessageDescriptor>;

export const monitorStatusMeta: Record<
	"collecting" | "backoff" | "inactive",
	{ label: MessageDescriptor; tone: StatusTone; busy?: boolean }
> = {
	collecting: { label: msg({ id: "Live" }), tone: "success", busy: true },
	backoff: { label: msg({ id: "Retrying" }), tone: "warning" },
	inactive: { label: msg({ id: "Not collecting" }), tone: "neutral" },
};
