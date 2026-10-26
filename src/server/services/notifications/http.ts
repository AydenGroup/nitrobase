import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { clip } from "#/libs/format.ts";
import {
	type PinnedAddress,
	PinnedHttpError,
	pinnedRequest,
	resolvePinned,
} from "#/server/services/pinned-http.ts";
import { DeliveryError } from "./message";
import type { HttpRequestSpec } from "./payloads";

const MAX_RESPONSE_BYTES = 64 * 1024;

/** Pinned-HTTP failures as notification delivery errors. */
function asDeliveryError(error: unknown): unknown {
	if (!(error instanceof PinnedHttpError)) return error;
	return new DeliveryError(
		error.kind === "too_large" ? "http" : error.kind,
		error.message,
		error.retryable,
	);
}

/** Every address `hostname` resolves to, refusing private ones. */
export async function resolvePublic(
	hostname: string,
	allowPrivate: boolean,
): Promise<PinnedAddress> {
	try {
		return await resolvePinned(hostname, allowPrivate);
	} catch (error) {
		throw asDeliveryError(error);
	}
}

/**
 * POST with SSRF guards (#/server/services/pinned-http.ts): pinned to the
 * checked address, no redirects, the response read up to 64 KiB.
 */
export async function postJson(
	spec: HttpRequestSpec,
	options: { allowPrivate: boolean; timeoutMs: number },
): Promise<{ status: number; body: string }> {
	try {
		const response = await pinnedRequest({
			url: spec.url,
			method: "POST",
			headers: spec.headers,
			body: spec.body,
			allowPrivate: options.allowPrivate,
			timeoutMs: options.timeoutMs,
			maxResponseBytes: MAX_RESPONSE_BYTES,
		});
		return { status: response.status, body: response.body.toString("utf8") };
	} catch (error) {
		throw asDeliveryError(error);
	}
}

/** Map an HTTP status to success or a classified failure. */
export function assertHttpOk(status: number, body: string): void {
	if (status >= 200 && status < 300) return;
	if (status >= 300 && status < 400) {
		// Following redirects would bypass the address checks.
		throw new DeliveryError("redirect", `HTTP ${status}`, false);
	}
	const detail = `HTTP ${status}${body ? `: ${clip(body, TEXT_LIMITS.shortText)}` : ""}`;
	if (status === 401 || status === 403 || status === 404) {
		throw new DeliveryError("auth", detail, false);
	}
	throw new DeliveryError("http", detail, status === 429 || status >= 500);
}
