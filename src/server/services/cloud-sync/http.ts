import type { CloudSyncProvider } from "#/config/cloud-sync.ts";
import { getConfig } from "#/config/server.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { sleep } from "#/libs/async.ts";
import { clip } from "#/libs/format.ts";
import {
	hostMatches,
	PinnedHttpError,
	type PinnedResponse,
	pinnedRequest,
	resolvePinned,
} from "#/server/services/pinned-http.ts";
import { AppError } from "#/utils/error.ts";

/**
 * Outbound calls of cloud sync: only to the provider's allowed hosts (plus
 * `CLOUD_SYNC_EXTRA_ALLOWED_HOSTS`), pinned to a public address (unless
 * `CLOUD_SYNC_ALLOW_PRIVATE`, test doubles), retried on 429/5xx.
 */

export function allowedHosts(provider: CloudSyncProvider): string[] {
	return [
		...provider.allowedHosts,
		...getConfig().CLOUD_SYNC_EXTRA_ALLOWED_HOSTS,
	];
}

/** The host must be on the provider's allowlist. */
function assertAllowedHost(provider: CloudSyncProvider, host: string): void {
	if (!hostMatches(host, allowedHosts(provider))) {
		throw new AppError("CLOUD_HOST_NOT_ALLOWED", { host });
	}
}

/** Allowlisted, then resolved and checked once: the address to connect to. */
export async function pinnedHost(
	provider: CloudSyncProvider,
	host: string,
): Promise<string> {
	assertAllowedHost(provider, host);
	try {
		return (await resolvePinned(host, getConfig().CLOUD_SYNC_ALLOW_PRIVATE))
			.address;
	} catch (error) {
		throw unreachable(error);
	}
}

function unreachable(error: unknown): AppError {
	return new AppError("CLOUD_API_UNREACHABLE", {
		detail: error instanceof Error ? error.message : String(error),
	});
}

/** An error's message, clipped for a coded `detail` param. */
export const errorDetail = (error: unknown) =>
	clip(
		error instanceof Error ? error.message : String(error),
		TEXT_LIMITS.errorDetail,
	);

/** How long to wait before retrying a rate-limited or failed call. */
export function retryDelayMs(
	headers: Record<string, string | string[] | undefined>,
	attempt: number,
	maxWaitMs: number,
): number {
	const header = (name: string) => {
		const value = headers[name];
		return Array.isArray(value) ? value[0] : value;
	};
	const retryAfter = Number(header("retry-after"));
	const reset = Number(header("x-ratelimit-reset"));
	const seconds = Number.isFinite(retryAfter)
		? retryAfter
		: Number.isFinite(reset)
			? reset
			: 2 ** attempt;
	return Math.min(maxWaitMs, Math.max(1000, seconds * 1000));
}

export type CloudMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Methods a retry cannot repeat with a different effect. */
const IDEMPOTENT = new Set<CloudMethod>(["GET", "HEAD", "PUT", "DELETE"]);

export interface CloudRequest {
	url: string;
	method?: CloudMethod;
	headers?: Record<string, string>;
	body?: string | Buffer;
	/**
	 * Retry 429/5xx and network errors (default: idempotent methods only;
	 * a POST that replaces by name, e.g. a function deploy, may opt in).
	 */
	retry?: boolean;
	/** Default: CLOUD_SYNC_API_MAX_BYTES; downloads fail when larger. */
	maxBytes?: number;
	signal?: AbortSignal;
}

/**
 * A request to an allowlisted host. Non-2xx answers become coded errors
 * (401/403: credentials) after the retries for 429 and 5xx (idempotent
 * requests only, unless `retry`).
 */
export async function cloudRequest(
	provider: CloudSyncProvider,
	request: CloudRequest,
): Promise<PinnedResponse> {
	const config = getConfig();
	const url = new URL(request.url);
	assertAllowedHost(provider, url.hostname);
	const method = request.method ?? "GET";
	const retries =
		(request.retry ?? IDEMPOTENT.has(method))
			? config.CLOUD_SYNC_API_RETRIES
			: 0;
	for (let attempt = 0; ; attempt++) {
		let response: PinnedResponse;
		try {
			response = await pinnedRequest({
				url: request.url,
				method,
				headers: request.headers,
				body: request.body,
				allowPrivate: config.CLOUD_SYNC_ALLOW_PRIVATE,
				timeoutMs: config.CLOUD_SYNC_HTTP_TIMEOUT_MS,
				maxResponseBytes: request.maxBytes ?? config.CLOUD_SYNC_API_MAX_BYTES,
				overflow: "error",
			});
		} catch (error) {
			if (error instanceof PinnedHttpError && error.kind === "too_large") {
				throw new AppError("CLOUD_API_TOO_LARGE", {
					max: { $bytes: request.maxBytes ?? config.CLOUD_SYNC_API_MAX_BYTES },
				});
			}
			const retry =
				error instanceof PinnedHttpError &&
				error.retryable &&
				attempt < retries;
			if (!retry) throw unreachable(error);
			await sleep(retryDelayMs({}, attempt, config.CLOUD_SYNC_API_MAX_WAIT_MS));
			continue;
		}
		if (response.status >= 200 && response.status < 300) return response;
		const retryable = response.status === 429 || response.status >= 500;
		if (retryable && attempt < retries) {
			if (request.signal?.aborted) break;
			await sleep(
				retryDelayMs(
					response.headers,
					attempt,
					config.CLOUD_SYNC_API_MAX_WAIT_MS,
				),
			);
			continue;
		}
		const detail = clip(
			response.body.toString("utf8"),
			TEXT_LIMITS.errorDetail,
		);
		if (response.status === 401 || response.status === 403) {
			throw new AppError("CLOUD_API_UNAUTHORIZED", { detail });
		}
		throw new AppError("CLOUD_API_FAILED", {
			status: response.status,
			detail,
		});
	}
	throw new AppError("CLOUD_API_UNREACHABLE", { detail: "aborted" });
}

/** `cloudRequest` + JSON parse (invalid JSON is a coded error). */
export async function cloudJson<T>(
	provider: CloudSyncProvider,
	request: CloudRequest,
): Promise<T> {
	const response = await cloudRequest(provider, {
		...request,
		headers: { accept: "application/json", ...request.headers },
	});
	try {
		return JSON.parse(response.body.toString("utf8")) as T;
	} catch {
		throw new AppError("CLOUD_API_INVALID_RESPONSE", {
			detail: clip(response.body.toString("utf8"), TEXT_LIMITS.errorDetail),
		});
	}
}
