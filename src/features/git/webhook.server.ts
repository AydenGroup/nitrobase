import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getConfig } from "#/config/server.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { isUniqueViolation } from "#/db/errors.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import { appGitSources, gitWebhookDeliveries } from "#/db/schema/git.ts";
import type { AppRow } from "#/features/apps/schema.ts";
import { systemActor } from "#/features/auth/access.ts";
import { onServerIdle } from "#/features/deployments/deployments.server.ts";
import { clip } from "#/libs/format.ts";
import { audit } from "#/server/services/audit.ts";
import { emitEvent } from "#/server/services/events/bus.ts";
import {
	providerFor,
	WEBHOOK_ID_PATTERN,
	type WebhookProvider,
	webhookProviders,
} from "#/server/services/git/webhooks.ts";
import { appLockKey } from "#/server/services/jobs/locks.ts";
import {
	createRateLimiter,
	type RateLimiter,
} from "#/server/services/rate-limit.ts";
import { currentRequestInfo } from "#/server/services/request-info.ts";
import { decrypt } from "#/utils/crypto.ts";
import { AppError } from "#/utils/error.ts";
import type { DeliveryStatus } from "./schema";

/**
 * Push webhooks of git apps (`POST /api/hooks/git/<hook id>`), the only
 * unauthenticated write endpoint: the request proves itself with the
 * app's webhook secret (provider registry in
 * `#/server/services/git/webhooks.ts`).
 *
 * - An unknown hook id, an unknown provider and a bad or missing
 *   signature all answer the same 401 after the same work
 *   (a dummy HMAC runs for unknown hooks), so the endpoint reveals nothing
 *   about which hooks exist.
 * - Rate limited per client IP and per hook id (429), bodies capped.
 * - Replays: a provider delivery id is accepted once per app (verified
 *   requests only, so a forged id can't block the real one); the generic
 *   provider also signs a timestamp checked against a window. A replayed
 *   push could only rebuild the branch tip anyway: builds always fetch the
 *   branch, never the commit named in the payload.
 * - Accepted pushes are debounced per app: a newer push supersedes a
 *   queued one; a busy server delays the build until it is idle.
 */

type Json = Record<string, unknown>;

const json = (status: number, body: Json, headers?: HeadersInit) =>
	Response.json(body, { status, headers });

const NO_APP = "00000000-0000-0000-0000-000000000000";

/** Same answer for every authentication failure. */
const unauthorized = () => json(401, { ok: false });

const globalState = globalThis as typeof globalThis & {
	__nitrobaseGitHooks?: {
		byIp: RateLimiter;
		byHook: RateLimiter;
		queue: Map<string, QueueEntry>;
		/** Delivery ids seen (key -> expiry), independent of row pruning. */
		replays: Map<string, number>;
	};
};

interface QueueEntry {
	deliveryIds: string[];
	firstQueuedAt: number;
	timer: ReturnType<typeof setTimeout> | null;
	/** Fails the deliveries when WEBHOOK_QUEUE_MAX_WAIT_MS is over. */
	giveUp: ReturnType<typeof setTimeout> | null;
	unsubscribe: (() => void) | null;
}

function state() {
	const config = getConfig();
	globalState.__nitrobaseGitHooks ??= {
		byIp: createRateLimiter({
			limit: config.WEBHOOK_RATE_LIMIT,
			windowMs: config.WEBHOOK_RATE_WINDOW_MS,
		}),
		byHook: createRateLimiter({
			limit: config.WEBHOOK_RATE_LIMIT,
			windowMs: config.WEBHOOK_RATE_WINDOW_MS,
		}),
		queue: new Map(),
		replays: new Map(),
	};
	globalState.__nitrobaseGitHooks.replays ??= new Map();
	return globalState.__nitrobaseGitHooks;
}

function seenDelivery(key: string): boolean {
	const expiry = state().replays.get(key);
	return expiry !== undefined && expiry > Date.now();
}

function rememberDelivery(key: string): void {
	const { replays } = state();
	const now = Date.now();
	if (replays.size > getConfig().WEBHOOK_REPLAY_MAX_ENTRIES) {
		for (const [item, expiry] of replays)
			if (expiry <= now) replays.delete(item);
	}
	replays.set(key, now + getConfig().WEBHOOK_REPLAY_TTL_MS);
}

/** Read at most `max` bytes of the body (null when larger). */
async function readBody(request: Request, max: number): Promise<Buffer | null> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > max) return null;
	if (!request.body) return Buffer.alloc(0);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

async function recordDelivery(values: {
	appId: string;
	provider: string;
	status: DeliveryStatus;
	reason?: string | null;
	deliveryId?: string | null;
	event?: string | null;
	branch?: string | null;
	commitSha?: string | null;
	ip: string | null;
}): Promise<string | null> {
	try {
		const [row] = await db
			.insert(gitWebhookDeliveries)
			.values({
				appId: values.appId,
				provider: values.provider,
				status: values.status,
				reason: values.reason ?? null,
				deliveryId: values.deliveryId ?? null,
				event: values.event ? clip(values.event, TEXT_LIMITS.identifier) : null,
				branch: values.branch ?? null,
				commitSha: values.commitSha ?? null,
				ip: values.ip,
			})
			.returning({ id: gitWebhookDeliveries.id });
		void import("./git.server")
			.then((module) => module.pruneDeliveries(values.appId))
			.catch(() => {});
		return row.id;
	} catch (error) {
		if (isUniqueViolation(error)) return null;
		throw error;
	}
}

export async function handleGitWebhook(
	request: Request,
	hookId: string,
): Promise<Response> {
	const config = getConfig();
	const { byIp, byHook } = state();
	const ip = currentRequestInfo().ip;
	// No address (no proxy info): the per-hook bucket alone, never one
	// shared "unknown" bucket that every sender would exhaust together.
	const ipLimited = ip ? byIp.isLimited(ip) : false;
	if (ipLimited || byHook.isLimited(hookId)) {
		const retry = Math.ceil(
			Math.max(ip ? byIp.retryAfterMs(ip) : 0, byHook.retryAfterMs(hookId)) /
				1000,
		);
		return json(429, { ok: false }, { "Retry-After": String(retry) });
	}
	if (ip) byIp.hit(ip);
	byHook.hit(hookId);

	const body = await readBody(request, config.WEBHOOK_MAX_BODY_BYTES);
	if (!body) return json(413, { ok: false });

	const [row] = WEBHOOK_ID_PATTERN.test(hookId)
		? await db
				.select()
				.from(appGitSources)
				.where(eq(appGitSources.webhookId, hookId))
				.limit(1)
		: [];
	const provider = providerFor(request.headers);
	const context = {
		now: Date.now(),
		toleranceSeconds: config.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
	};
	if (!row || !provider) {
		// Same work as a real check (the app lookup, an HMAC), then the same
		// answer; nothing is recorded.
		await db
			.select({ id: apps.id })
			.from(apps)
			.where(eq(apps.id, NO_APP))
			.limit(1);
		(provider ?? webhookProviders[0]).verify(
			request.headers,
			body,
			randomBytes(32).toString("hex"),
			context,
		);
		return unauthorized();
	}
	const [app] = await db
		.select()
		.from(apps)
		.where(eq(apps.id, row.appId))
		.limit(1);
	if (!app) return unauthorized();

	const verdict = provider.verify(
		request.headers,
		body,
		decrypt(row.webhookSecretEncrypted),
		context,
	);
	if (!verdict.ok) {
		// Recorded after answering: a known hook answers as fast as an
		// unknown one.
		void rejected(app, provider, verdict.reason, ip).catch((error) =>
			console.error("[git-webhook] could not record a rejection", error),
		);
		return unauthorized();
	}

	const event = provider.event(request.headers);
	const deliveryId = provider.deliveryId(request.headers);
	const base = { appId: app.id, provider: provider.id, event, ip };
	if (!row.webhookEnabled) {
		await recordDelivery({ ...base, status: "ignored", reason: "disabled" });
		return json(202, { ok: true, status: "ignored" });
	}
	if (!provider.isPush(event)) {
		await recordDelivery({ ...base, status: "ignored", reason: "event" });
		return json(202, { ok: true, status: "ignored" });
	}
	let payload: unknown;
	try {
		payload = JSON.parse(body.toString("utf8"));
	} catch {
		await recordDelivery({ ...base, status: "ignored", reason: "payload" });
		return json(400, { ok: false });
	}
	const push = provider.parse(payload);
	const details = {
		...base,
		branch: push.branch,
		commitSha: push.commitSha,
	};
	if (push.branch !== row.branch || push.deleted) {
		await recordDelivery({
			...details,
			status: "ignored",
			reason: push.deleted ? "deleted" : "branch",
		});
		return json(202, { ok: true, status: "ignored" });
	}
	const replayKey = deliveryId
		? `${app.id}:${provider.id}:${deliveryId}`
		: null;
	const id =
		replayKey && seenDelivery(replayKey)
			? null
			: await recordDelivery({ ...details, deliveryId, status: "queued" });
	if (replayKey) rememberDelivery(replayKey);
	if (!id) {
		await recordDelivery({ ...details, status: "duplicate", reason: "replay" });
		return json(202, { ok: true, status: "duplicate" });
	}
	audit({
		actor: systemActor(app.teamId, app.userId),
		action: "app.webhook.received",
		targetType: "app",
		targetId: app.id,
		meta: {
			provider: provider.id,
			branch: push.branch,
			commit: push.commitSha,
			delivery: deliveryId,
		},
	});
	enqueueBuild(app.id, id);
	return json(202, { ok: true, status: "queued" });
}

async function rejected(
	app: AppRow,
	provider: WebhookProvider,
	reason: string,
	ip: string | null,
): Promise<void> {
	await recordDelivery({
		appId: app.id,
		provider: provider.id,
		status: "rejected",
		reason,
		ip,
	});
	audit({
		actor: systemActor(app.teamId, null),
		action: "app.webhook.rejected",
		targetType: "app",
		targetId: app.id,
		meta: { provider: provider.id, reason },
	});
	emitEvent({
		id: "webhook.rejected",
		teamId: app.teamId,
		subject: `webhook:${app.id}`,
		serverId: app.serverId,
		appId: app.id,
		params: { reason, ip: ip ?? "?" },
	});
}

// ---------------------------------------------------------------------------
// Debounced build queue (in-process: single instance)

function clearEntry(entry: QueueEntry) {
	if (entry.timer) clearTimeout(entry.timer);
	if (entry.giveUp) clearTimeout(entry.giveUp);
	entry.unsubscribe?.();
	entry.timer = null;
	entry.giveUp = null;
	entry.unsubscribe = null;
}

/** Only queued rows change: a superseded delivery stays superseded. */
async function settleQueued(
	ids: string[],
	patch: Partial<typeof gitWebhookDeliveries.$inferInsert>,
): Promise<void> {
	if (ids.length === 0) return;
	await db
		.update(gitWebhookDeliveries)
		.set(patch)
		.where(
			and(
				inArray(gitWebhookDeliveries.id, ids),
				eq(gitWebhookDeliveries.status, "queued"),
			),
		);
}

/** Drop `entry` from the queue unless a newer push replaced it already. */
function forget(appId: string, entry: QueueEntry): void {
	const { queue } = state();
	if (queue.get(appId) === entry) queue.delete(appId);
	clearEntry(entry);
}

/** Queue a build; a newer push supersedes the queued one. */
function enqueueBuild(appId: string, deliveryId: string): void {
	const { queue } = state();
	const existing = queue.get(appId);
	if (existing) {
		clearEntry(existing);
		void settleQueued(existing.deliveryIds, {
			status: "superseded",
			reason: "newer_push",
		});
	}
	const entry: QueueEntry = {
		deliveryIds: [deliveryId],
		firstQueuedAt: existing?.firstQueuedAt ?? Date.now(),
		timer: null,
		giveUp: null,
		unsubscribe: null,
	};
	queue.set(appId, entry);
	entry.timer = setTimeout(
		() => void fire(appId, entry),
		getConfig().WEBHOOK_DEBOUNCE_MS,
	);
}

async function fire(appId: string, entry: QueueEntry): Promise<void> {
	const { queue } = state();
	if (queue.get(appId) !== entry) return;
	if (entry.timer) clearTimeout(entry.timer);
	entry.timer = null;
	entry.unsubscribe?.();
	entry.unsubscribe = null;
	const [app] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
	if (!app) {
		forget(appId, entry);
		return;
	}
	try {
		const { startBuildAndDeploy } = await import("./git.server");
		const { deploymentId } = await startBuildAndDeploy(
			systemActor(app.teamId, app.userId),
			app,
			{ trigger: "webhook" },
		);
		forget(appId, entry);
		await settleQueued(entry.deliveryIds, {
			status: "deployed",
			deploymentId,
			// Built only: the owner stopped the app (deploy it by hand later).
			reason: app.status === "stopped" ? "app_stopped" : null,
		});
	} catch (error) {
		const busy = error instanceof AppError && error.code === "SERVER_BUSY";
		const maxWait = getConfig().WEBHOOK_QUEUE_MAX_WAIT_MS;
		const left = entry.firstQueuedAt + maxWait - Date.now();
		if (busy && left > 0) {
			// Retry when this app's lock or the server lock is released;
			// give up when the wait is over even if nothing is released.
			entry.unsubscribe = onServerIdle((key) => {
				if (key !== app.serverId && key !== appLockKey(app.id)) return;
				entry.unsubscribe?.();
				entry.unsubscribe = null;
				entry.timer = setTimeout(
					() => void fire(appId, entry),
					getConfig().WEBHOOK_QUEUE_RETRY_DELAY_MS,
				);
			});
			entry.giveUp ??= setTimeout(() => {
				if (state().queue.get(appId) !== entry) return;
				forget(appId, entry);
				void settleQueued(entry.deliveryIds, {
					status: "failed",
					reason: "server_busy",
				});
			}, left);
			return;
		}
		forget(appId, entry);
		await settleQueued(entry.deliveryIds, {
			status: "failed",
			reason: busy
				? "server_busy"
				: error instanceof AppError
					? error.code
					: "error",
		});
	}
}
