import { useQuery } from "@tanstack/react-query";
import { StatusBadge, StatusDot } from "#/components/ui/StatusBadge";
import { serverStatusMeta } from "#/config/status.ts";
import { alertsQueryOptions } from "#/features/monitoring/monitoring.query.ts";
import type { AlertDTO } from "#/features/monitoring/schema.ts";
import type { ServerStatus } from "#/features/servers/schema.ts";

/** Servers with an open "unreachable" alert (derived, not stored). */
export function unreachableServerIds(alerts: AlertDTO[] | undefined) {
	return new Set(
		(alerts ?? [])
			.filter(
				(alert) =>
					alert.rule === "server_unreachable" && alert.status === "open",
			)
			.map((alert) => alert.serverId),
	);
}

export function useUnreachableServers(): Set<string> {
	const alerts = useQuery(alertsQueryOptions());
	return unreachableServerIds(alerts.data);
}

/** Stored status, shown as Unreachable while monitoring can't reach it. */
export function liveServerStatus(
	server: { id: string; status: ServerStatus },
	unreachable: Set<string>,
): ServerStatus {
	return server.status === "ready" && unreachable.has(server.id)
		? "unreachable"
		: server.status;
}

export const ServerLiveStatusBadge: React.FC<{
	server: { id: string; status: ServerStatus; isDefault?: boolean };
	unreachable: Set<string>;
	dot?: boolean;
}> = ({ server, unreachable, dot = false }) => {
	const meta = serverStatusMeta({
		status: liveServerStatus(server, unreachable),
		isDefault: server.isDefault,
	});
	return dot ? <StatusDot meta={meta} /> : <StatusBadge meta={meta} />;
};
