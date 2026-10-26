import { and, desc, eq, gt, lt } from "drizzle-orm";
import { getEventDefinition } from "#/config/notification-events.ts";
import { appBaseUrl, getConfig } from "#/config/server.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import {
	notificationChannels,
	notificationDeliveries,
} from "#/db/schema/platform.ts";
import { servers } from "#/db/schema/server.ts";
import { users } from "#/db/schema/user.ts";
import { sleep } from "#/libs/async.ts";
import { clip } from "#/libs/format.ts";
import {
	emitEvent,
	onEvent,
	type PlatformEvent,
} from "#/server/services/events/bus.ts";
import { onAlert } from "#/server/services/monitoring/events.ts";
import {
	admitDelivery,
	dedupeKeyOf,
	matchesSubscription,
	retryDelayMs,
	scrubSecrets,
} from "#/server/services/notifications/dispatch.ts";
import { sendThroughChannel } from "#/server/services/notifications/drivers.ts";
import { DeliveryError } from "#/server/services/notifications/message.ts";
import { renderEvent } from "#/server/services/notifications/render.ts";
import { channelConfig } from "./channels.server";
import { notificationI18n } from "./i18n.server";
import type { ChannelRow } from "./schema";

async function names(event: PlatformEvent) {
	const [server] = event.serverId
		? await db
				.select({ name: servers.name })
				.from(servers)
				.where(eq(servers.id, event.serverId))
				.limit(1)
		: [];
	const [app] = event.appId
		? await db
				.select({ name: apps.name })
				.from(apps)
				.where(eq(apps.id, event.appId))
				.limit(1)
		: [];
	const [user] = event.userId
		? await db
				.select({ email: users.email })
				.from(users)
				.where(eq(users.id, event.userId))
				.limit(1)
		: [];
	return {
		serverName: server?.name ?? null,
		appName: app?.name ?? null,
		user: user?.email ?? "",
	};
}

/** Deliver one rendered event to one channel, with retries and a record. */
async function deliver(
	channel: ChannelRow,
	event: PlatformEvent,
	message: ReturnType<typeof renderEvent>,
): Promise<void> {
	const config = getConfig();
	const dedupeKey = dedupeKeyOf(event);
	const now = new Date();
	const windowStart = new Date(
		now.getTime() -
			Math.max(config.NOTIFY_DEDUPE_WINDOW_MS, config.NOTIFY_RATE_WINDOW_MS),
	);
	const recent = await db
		.select({
			dedupeKey: notificationDeliveries.dedupeKey,
			status: notificationDeliveries.status,
			createdAt: notificationDeliveries.createdAt,
		})
		.from(notificationDeliveries)
		.where(
			and(
				eq(notificationDeliveries.channelId, channel.id),
				gt(notificationDeliveries.createdAt, windowStart),
			),
		)
		.orderBy(desc(notificationDeliveries.createdAt))
		.limit(config.NOTIFY_RATE_LIMIT + 500);
	const admission = admitDelivery(recent, dedupeKey, now, {
		dedupeWindowMs: config.NOTIFY_DEDUPE_WINDOW_MS,
		rateLimit: config.NOTIFY_RATE_LIMIT,
		rateWindowMs: config.NOTIFY_RATE_WINDOW_MS,
		critical: getEventDefinition(event.id)?.critical,
	});
	const [row] = await db
		.insert(notificationDeliveries)
		.values({
			channelId: channel.id,
			eventId: event.id,
			dedupeKey,
			title: clip(message.title, TEXT_LIMITS.message),
			status: admission.send ? "pending" : "suppressed",
			lastError: admission.send ? null : admission.reason,
		})
		.returning({ id: notificationDeliveries.id });
	if (!admission.send) return;

	const { config: channelSettings, secrets } = channelConfig(channel);
	for (let attempt = 1; attempt <= config.NOTIFY_MAX_ATTEMPTS; attempt++) {
		if (attempt > 1)
			await sleep(retryDelayMs(attempt, config.NOTIFY_RETRY_BASE_MS));
		try {
			await sendThroughChannel(channel.type, channelSettings, message, {
				timeoutMs: config.NOTIFY_TIMEOUT_MS,
				telegramApiUrl: config.TELEGRAM_API_URL,
				now: new Date(),
			});
			await db
				.update(notificationDeliveries)
				.set({
					status: "sent",
					attempts: attempt,
					sentAt: new Date(),
					lastError: null,
				})
				.where(eq(notificationDeliveries.id, row.id));
			return;
		} catch (error) {
			const retryable = error instanceof DeliveryError ? error.retryable : true;
			const kind = error instanceof DeliveryError ? error.kind : "unknown";
			const text = scrubSecrets(
				error instanceof Error ? error.message : String(error),
				secrets,
			);
			const last = !retryable || attempt === config.NOTIFY_MAX_ATTEMPTS;
			await db
				.update(notificationDeliveries)
				.set({
					status: last ? "failed" : "pending",
					attempts: attempt,
					lastError: clip(`${kind}: ${text}`, TEXT_LIMITS.storedError),
				})
				.where(eq(notificationDeliveries.id, row.id));
			if (last) return;
		}
	}
}

/**
 * Route one platform event to every matching enabled channel: the team's
 * channels, or for account events (no team) the channels the member created.
 */
async function dispatchEvent(event: PlatformEvent): Promise<void> {
	const definition = getEventDefinition(event.id);
	if (!definition) {
		console.warn(`[notifications] unknown event ${event.id}`);
		return;
	}
	// Nobody to address (e.g. an anonymous sign-in failure).
	if (!event.teamId && !event.userId) return;
	const channels = await db
		.select()
		.from(notificationChannels)
		.where(
			and(
				event.teamId
					? eq(notificationChannels.teamId, event.teamId)
					: eq(notificationChannels.userId, event.userId as string),
				eq(notificationChannels.enabled, true),
			),
		);
	const targets = channels.filter((channel) =>
		matchesSubscription(channel.subscription, event),
	);
	if (targets.length === 0) return;
	const i18n = notificationI18n();
	const message = renderEvent(event, definition, {
		i18n,
		...(await names(event)),
		baseUrl: appBaseUrl(),
		labels: { server: i18n._("Server"), app: i18n._("App") },
	});
	await Promise.all(
		targets.map((channel) =>
			deliver(channel, event, message).catch((error) =>
				console.error(
					`[notifications] delivery to ${channel.id} failed`,
					error,
				),
			),
		),
	);
}

const globalState = globalThis as typeof globalThis & {
	__nitrobaseNotifyRegistered?: boolean;
};

/**
 * Boot: subscribe to platform events and map monitoring alerts onto the
 * catalog (unreachable servers get their own events).
 */
/** Delivery error kind (`deliveryErrorLabels`) of a delivery cut by a restart. */
const INTERRUPTED_KIND = "interrupted";

export function registerNotificationDispatcher(): void {
	if (globalState.__nitrobaseNotifyRegistered) return;
	globalState.__nitrobaseNotifyRegistered = true;
	onEvent(dispatchEvent);
	onAlert(({ type, alert }) => {
		const unreachable = alert.rule === "server_unreachable";
		emitEvent({
			id: unreachable
				? type === "opened"
					? "server.unreachable"
					: "server.reachable"
				: type === "opened"
					? "alert.opened"
					: "alert.resolved",
			teamId: alert.teamId,
			subject: `${alert.rule}:${alert.subject}`,
			serverId: alert.serverId,
			appId: alert.appId,
			severity:
				type === "resolved"
					? "info"
					: alert.severity === "critical"
						? "critical"
						: "warning",
			params: {
				rule: alert.rule,
				subject: alert.subject,
				value:
					alert.value === null
						? "—"
						: String(Math.round(alert.value * 10) / 10),
				threshold: alert.threshold === null ? "—" : String(alert.threshold),
			},
		});
	});
	// Deliveries left pending by a restart will not be retried.
	void db
		.update(notificationDeliveries)
		.set({ status: "failed", lastError: INTERRUPTED_KIND })
		.where(
			and(
				eq(notificationDeliveries.status, "pending"),
				lt(notificationDeliveries.createdAt, new Date()),
			),
		)
		.catch(() => undefined);
}

/** Retention of the delivery log. */
export async function pruneDeliveries(now = new Date()): Promise<void> {
	const cutoff = new Date(
		now.getTime() - getConfig().NOTIFY_DELIVERY_RETENTION_DAYS * 86_400_000,
	);
	await db
		.delete(notificationDeliveries)
		.where(lt(notificationDeliveries.createdAt, cutoff));
}
