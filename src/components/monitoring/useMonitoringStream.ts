import { useEffect, useState } from "react";
import type {
	LiveTick,
	MonitoringSnapshot,
	MonitorStatus,
} from "#/features/monitoring/schema.ts";
import { closeOnSessionEnded } from "#/libs/session-ended.ts";

export interface MonitoringStreamState {
	connection: "connecting" | "open" | "error";
	status: MonitorStatus;
	ticks: LiveTick[];
	thresholds: MonitoringSnapshot["thresholds"] | null;
	intervalMs: number | null;
}

const initial: MonitoringStreamState = {
	connection: "connecting",
	status: "inactive",
	ticks: [],
	thresholds: null,
	intervalMs: null,
};

/**
 * Live monitoring ticks over SSE (`/api/servers/:id/metrics` or
 * `/api/apps/:id/metrics`). Keeps at most `maxTicks` (oldest dropped).
 * EventSource reconnects by itself; a reconnect gets a fresh snapshot.
 */
export function useMonitoringStream(
	url: string | null,
	maxTicks = 60,
): MonitoringStreamState {
	const [state, setState] = useState<MonitoringStreamState>(initial);
	useEffect(() => {
		if (!url) return;
		setState(initial);
		const es = new EventSource(url);
		closeOnSessionEnded(es);
		const parse = <T>(event: Event): T | null => {
			try {
				return JSON.parse((event as MessageEvent).data) as T;
			} catch {
				return null;
			}
		};
		es.addEventListener("snapshot", (event) => {
			const snapshot = parse<MonitoringSnapshot>(event);
			if (!snapshot) return;
			setState({
				connection: "open",
				status: snapshot.status,
				ticks: snapshot.ticks.slice(-maxTicks),
				thresholds: snapshot.thresholds,
				intervalMs: snapshot.intervalMs,
			});
		});
		es.addEventListener("tick", (event) => {
			const tick = parse<LiveTick>(event);
			if (!tick) return;
			setState((prev) => ({
				...prev,
				connection: "open",
				status: tick.ok ? "collecting" : "backoff",
				ticks: [...prev.ticks, tick].slice(-maxTicks),
			}));
		});
		es.addEventListener("error", () => {
			setState((prev) => ({ ...prev, connection: "error" }));
		});
		return () => es.close();
	}, [url, maxTicks]);
	return state;
}
