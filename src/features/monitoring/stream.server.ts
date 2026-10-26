import { getConfig } from "#/config/server.ts";
import type { Actor } from "#/features/auth/access.ts";
import {
	liveConnectionOf,
	liveSessionSignal,
} from "#/features/auth/sessions.server.ts";
import { createSseStream, sseResponse } from "#/server/services/sse.ts";
import type { LiveTick, MonitoringSnapshot } from "./schema";
import { initialTicks, liveSnapshot, subscribeTicks } from "./service.server";

// Per-user open monitoring streams (single instance, in-process).
const globalStreams = globalThis as typeof globalThis & {
	__nitrobaseMonitoringStreams?: Map<string, number>;
};
globalStreams.__nitrobaseMonitoringStreams ??= new Map();
const activeStreams = globalStreams.__nitrobaseMonitoringStreams;

/**
 * SSE stream of a server's live ticks (`snapshot` first, then `tick`), or
 * of one app's containers when `filter` narrows each tick. Ownership must
 * be checked by the caller. Streams per user are capped; heartbeats keep
 * proxies from closing idle streams; abort unsubscribes.
 */
export async function monitoringStream(options: {
	/** The stream closes when its session/token ends or the role loses access. */
	actor: Actor;
	serverId: string;
	signal: AbortSignal;
	filter?: (tick: LiveTick) => LiveTick;
}): Promise<Response> {
	const config = getConfig();
	const { serverId } = options;
	const identity = liveConnectionOf(options.actor, "monitoring.view");
	const userId = identity.userId;
	const filter = options.filter ?? ((tick: LiveTick) => tick);
	const active = activeStreams.get(userId) ?? 0;
	if (active >= config.MONITORING_STREAMS_PER_USER) {
		return Response.json({ error: "too_many_streams" }, { status: 429 });
	}
	activeStreams.set(userId, active + 1);
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		const count = (activeStreams.get(userId) ?? 1) - 1;
		if (count <= 0) activeStreams.delete(userId);
		else activeStreams.set(userId, count);
	};

	let ticks: LiveTick[];
	try {
		ticks = await initialTicks(serverId);
	} catch (error) {
		release();
		throw error;
	}
	const live = liveSessionSignal(identity, options.signal);
	const body = createSseStream({
		signal: live.signal,
		start(channel) {
			channel.onClose(() => {
				live.release();
				release();
			});
			const snapshot: MonitoringSnapshot = {
				status: liveSnapshot(serverId).status,
				ticks: ticks.map(filter),
				thresholds: {
					diskPercent: config.ALERT_DISK_PERCENT,
					memoryPercent: config.ALERT_MEMORY_PERCENT,
				},
				intervalMs: config.MONITORING_INTERVAL_MS,
			};
			channel.event("snapshot", snapshot);
			const unsubscribe = subscribeTicks(serverId, (tick) =>
				channel.event("tick", filter(tick)),
			);
			channel.onClose(unsubscribe);
		},
	});
	return sseResponse(body);
}
