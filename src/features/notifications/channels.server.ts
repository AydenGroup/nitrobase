import { randomBytes } from "node:crypto";
import { and, desc, eq, type SQL } from "drizzle-orm";
import {
	channelFields,
	getChannelDriver,
} from "#/config/notification-channels.ts";
import {
	defaultSubscribedEvents,
	getEventDefinition,
} from "#/config/notification-events.ts";
import {
	describeSchemaError,
	secretFieldNames,
} from "#/config/schema-fields.ts";
import { appBaseUrl, getConfig } from "#/config/server.ts";
import { APP_NAME } from "#/config/shared.ts";
import { db } from "#/db/index.ts";
import {
	notificationChannels,
	notificationDeliveries,
} from "#/db/schema/platform.ts";
import { users } from "#/db/schema/user.ts";
import type { Actor } from "#/features/auth/access.ts";
import { assertCanAccess, NIL_UUID } from "#/features/auth/access.ts";
import { SECRET_MASK } from "#/server/services/apps/env-state.ts";
import { audit } from "#/server/services/audit.ts";
import {
	checkEndpointHost,
	endpointHostOf,
} from "#/server/services/endpoint-guard.ts";
import { scrubSecrets } from "#/server/services/notifications/dispatch.ts";
import { sendThroughChannel } from "#/server/services/notifications/drivers.ts";
import {
	DeliveryError,
	type NotificationMessage,
} from "#/server/services/notifications/message.ts";
import { renderSampleEvent } from "#/server/services/notifications/render.ts";
import { decrypt, encrypt } from "#/utils/crypto.ts";
import { AppError } from "#/utils/error.ts";
import { notificationI18n } from "./i18n.server";
import type {
	ChannelDTO,
	ChannelRow,
	ChannelSubscription,
	DeliveryDTO,
} from "./schema";

async function getChannelRow(actor: Actor, id: string): Promise<ChannelRow> {
	const [row] = await db
		.select()
		.from(notificationChannels)
		.where(eq(notificationChannels.id, id))
		.limit(1);
	return assertCanAccess(
		actor,
		row,
		"notification.manage",
		"NOTIFICATION_CHANNEL_NOT_FOUND",
	);
}

function driverOf(type: string) {
	const driver = getChannelDriver(type);
	if (!driver) {
		throw new AppError("CHANNEL_TYPE_UNKNOWN", { type });
	}
	return driver;
}

/** Decrypted, validated config and its secret values (server-only). */
export function channelConfig(row: ChannelRow): {
	config: Record<string, unknown>;
	secrets: string[];
} {
	const driver = driverOf(row.type);
	const config = driver.schema.parse(
		JSON.parse(decrypt(row.configEncrypted)),
	) as Record<string, unknown>;
	const secrets = secretFieldNames(driver.schema)
		.map((name) => config[name])
		.filter((value): value is string => typeof value === "string");
	return { config, secrets };
}

/**
 * Validate a submitted config: masked/omitted secrets keep their stored
 * value, generated fields are created by the server (never from input).
 */
function validateConfig(
	type: string,
	input: Record<string, unknown>,
	previous: Record<string, unknown> = {},
): Record<string, unknown> {
	const driver = driverOf(type);
	const merged = { ...input };
	for (const field of channelFields(driver)) {
		if (field.meta.generated) {
			merged[field.name] =
				previous[field.name] ?? randomBytes(32).toString("hex");
			continue;
		}
		if (
			field.meta.secret &&
			(merged[field.name] === SECRET_MASK || merged[field.name] === undefined)
		) {
			merged[field.name] = previous[field.name];
		}
	}
	const parsed = driver.schema.safeParse(merged);
	if (!parsed.success) {
		throw new AppError(
			"CHANNEL_FIELD_INVALID",
			describeSchemaError(driver.schema, parsed.error),
		);
	}
	return parsed.data as Record<string, unknown>;
}

/**
 * Save-time SSRF check of the channel endpoint (webhook URL, SMTP host):
 * public addresses only unless "private network" is on.
 */
async function assertPublicEndpoint(config: Record<string, unknown>) {
	const host =
		endpointHostOf(config.webhookUrl) ??
		endpointHostOf(config.url) ??
		endpointHostOf(config.host);
	if (!host) return;
	const verdict = await checkEndpointHost(host, {
		allowPrivate: config.privateNetwork === true,
	});
	if (verdict === "private") throw new AppError("ENDPOINT_PRIVATE", { host });
	if (verdict === "unresolved") {
		throw new AppError("ENDPOINT_UNRESOLVED", { host });
	}
}

function toDTO(row: ChannelRow): ChannelDTO {
	const driver = getChannelDriver(row.type);
	const config = JSON.parse(
		decrypt(row.configEncrypted),
	) as ChannelDTO["config"];
	for (const name of driver ? secretFieldNames(driver.schema) : []) {
		if (config[name]) config[name] = SECRET_MASK;
	}
	return {
		id: row.id,
		name: row.name,
		type: row.type,
		config,
		enabled: row.enabled,
		subscription: row.subscription,
		lastTest: row.lastTest ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export async function listChannels(actor: Actor): Promise<ChannelDTO[]> {
	const rows = await db
		.select()
		.from(notificationChannels)
		.where(eq(notificationChannels.teamId, actor.teamId))
		.orderBy(notificationChannels.name);
	return rows.map(toDTO);
}

export async function createChannel(
	actor: Actor,
	input: {
		name: string;
		type: string;
		config: Record<string, unknown>;
		enabled: boolean;
		subscription?: ChannelSubscription;
	},
): Promise<{ id: string }> {
	const config = validateConfig(input.type, input.config);
	await assertPublicEndpoint(config);
	const [row] = await db
		.insert(notificationChannels)
		.values({
			teamId: actor.teamId,
			userId: actor.userId,
			name: input.name,
			type: input.type,
			configEncrypted: encrypt(JSON.stringify(config)),
			enabled: input.enabled,
			subscription: input.subscription ?? {
				events: defaultSubscribedEvents(),
				serverIds: [],
				appIds: [],
			},
		})
		.returning({ id: notificationChannels.id });
	audit({
		actor,
		action: "notification.channel.create",
		targetType: "notification_channel",
		targetId: row.id,
		meta: { type: input.type, name: input.name },
	});
	return row;
}

export async function updateChannel(
	actor: Actor,
	input: {
		id: string;
		name: string;
		type: string;
		config: Record<string, unknown>;
		enabled: boolean;
		subscription?: ChannelSubscription;
	},
): Promise<void> {
	const row = await getChannelRow(actor, input.id);
	const previous = JSON.parse(decrypt(row.configEncrypted));
	const config = validateConfig(row.type, input.config, previous);
	await assertPublicEndpoint(config);
	await db
		.update(notificationChannels)
		.set({
			name: input.name,
			configEncrypted: encrypt(JSON.stringify(config)),
			enabled: input.enabled,
			...(input.subscription ? { subscription: input.subscription } : {}),
			updatedAt: new Date(),
		})
		.where(eq(notificationChannels.id, row.id));
	audit({
		actor,
		action: "notification.channel.update",
		targetType: "notification_channel",
		targetId: row.id,
		meta: {
			name: input.name,
			enabled: input.enabled,
			events: input.subscription?.events.length,
		},
	});
}

export async function deleteChannel(actor: Actor, id: string): Promise<void> {
	const row = await getChannelRow(actor, id);
	await db
		.delete(notificationChannels)
		.where(eq(notificationChannels.id, row.id));
	audit({
		actor,
		action: "notification.channel.delete",
		targetType: "notification_channel",
		targetId: row.id,
		meta: { type: row.type, name: row.name },
	});
}

/** The webhook signing secret, for configuring the receiver (audited). */
export async function revealSigningSecret(
	actor: Actor,
	id: string,
): Promise<{ secret: string }> {
	const row = await getChannelRow(actor, id);
	const { config } = channelConfig(row);
	const secret = config.signingSecret;
	if (typeof secret !== "string") {
		throw new AppError("CHANNEL_NO_SIGNING_SECRET");
	}
	audit({
		actor,
		action: "notification.channel.secret_reveal",
		targetType: "notification_channel",
		targetId: row.id,
	});
	return { secret };
}

/** Send one test message right away (no dedupe, no retries). */
export async function testChannel(
	actor: Actor,
	id: string,
	/** Send this catalog event as a sample ("Send test" per event). */
	eventId?: string,
): Promise<{ ok: boolean; kind: string | null; error: string | null }> {
	const row = await getChannelRow(actor, id);
	const { config, secrets } = channelConfig(row);
	const i18n = notificationI18n();
	const baseUrl = appBaseUrl();
	let message: NotificationMessage;
	if (eventId) {
		const definition = getEventDefinition(eventId);
		if (!definition) {
			throw new AppError("CHANNEL_EVENT_UNKNOWN", { event: eventId });
		}
		const [owner] = await db
			.select({ email: users.email })
			.from(users)
			.where(eq(users.id, actor.userId ?? NIL_UUID))
			.limit(1);
		message = renderSampleEvent(definition, {
			i18n,
			user: owner?.email ?? "",
			serverName: null,
			appName: null,
			baseUrl,
			labels: { server: i18n._("Server"), app: i18n._("App") },
			prefix: i18n._("[Test]"),
			samples: {
				target: i18n._("Test app"),
				server: i18n._("Test server"),
				ip: "203.0.113.7",
				device: "Firefox · Linux",
				error: i18n._("This is a test message"),
				detail: i18n._("This is a test message"),
				default: i18n._("example"),
			},
		});
	} else {
		message = {
			eventId: "test",
			severity: "info",
			title: i18n._("{appName} test notification", { appName: APP_NAME }),
			body: i18n._("If you can read this, the {name} channel works.", {
				name: row.name,
			}),
			url: baseUrl,
			at: new Date(),
			fields: [],
		};
	}
	const appConfig = getConfig();
	let result: { ok: boolean; kind: string | null; error: string | null };
	try {
		await sendThroughChannel(row.type, config, message, {
			timeoutMs: appConfig.NOTIFY_TIMEOUT_MS,
			telegramApiUrl: appConfig.TELEGRAM_API_URL,
			now: new Date(),
		});
		result = { ok: true, kind: null, error: null };
	} catch (error) {
		const kind = error instanceof DeliveryError ? error.kind : "unknown";
		const text = error instanceof Error ? error.message : String(error);
		result = { ok: false, kind, error: scrubSecrets(text, secrets) };
	}
	await db
		.update(notificationChannels)
		.set({
			lastTest: {
				ok: result.ok,
				error: result.error ? `${result.kind}: ${result.error}` : null,
				at: new Date().toISOString(),
			},
		})
		.where(eq(notificationChannels.id, row.id));
	audit({
		actor,
		action: "notification.channel.test",
		targetType: "notification_channel",
		targetId: row.id,
		meta: { ok: result.ok, kind: result.kind, event: eventId ?? null },
	});
	return result;
}

export async function listDeliveries(
	actor: Actor,
	filters: { channelId?: string; limit: number },
): Promise<DeliveryDTO[]> {
	const where: SQL[] = [eq(notificationChannels.teamId, actor.teamId)];
	if (filters.channelId) {
		where.push(eq(notificationDeliveries.channelId, filters.channelId));
	}
	return db
		.select({
			id: notificationDeliveries.id,
			channelId: notificationDeliveries.channelId,
			channelName: notificationChannels.name,
			eventId: notificationDeliveries.eventId,
			title: notificationDeliveries.title,
			status: notificationDeliveries.status,
			attempts: notificationDeliveries.attempts,
			lastError: notificationDeliveries.lastError,
			createdAt: notificationDeliveries.createdAt,
			sentAt: notificationDeliveries.sentAt,
		})
		.from(notificationDeliveries)
		.innerJoin(
			notificationChannels,
			eq(notificationChannels.id, notificationDeliveries.channelId),
		)
		.where(and(...where))
		.orderBy(desc(notificationDeliveries.createdAt))
		.limit(filters.limit);
}
