import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isPrivateHost } from "#/config/ip-ranges.ts";

/**
 * Outbound HTTP with SSRF guards, shared by every caller that reaches a
 * user-influenced or third-party host (notification webhooks, cloud sync
 * provider APIs): the host is resolved and checked once, the connection is
 * pinned to that address (no second lookup to rebind), redirects are never
 * followed and the response is read up to a cap.
 */

export type PinnedHttpErrorKind =
	| "blocked"
	| "network"
	| "timeout"
	| "too_large";

/** A failed request (callers map the kind to their own errors). */
export class PinnedHttpError extends Error {
	constructor(
		readonly kind: PinnedHttpErrorKind,
		message: string,
		/** Worth another attempt (network trouble, timeouts). */
		readonly retryable: boolean,
	) {
		super(message);
		this.name = "PinnedHttpError";
	}
}

/** `::ffff:1.2.3.4` → `1.2.3.4` (sockets report mapped addresses). */
function normalizeAddress(address: string): string {
	return address.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");
}

export interface PinnedAddress {
	address: string;
	family: number;
}

type Resolve = (host: string) => Promise<PinnedAddress[]>;

const systemResolve: Resolve = (host) =>
	lookup(host, { all: true, verbatim: true });

/** The first address `hostname` resolves to, refusing private ones. */
export async function resolvePinned(
	hostname: string,
	allowPrivate: boolean,
	resolve: Resolve = systemResolve,
): Promise<PinnedAddress> {
	const host = hostname.replace(/^\[|\]$/g, "");
	const addresses = isIP(host)
		? [{ address: host, family: isIP(host) }]
		: await resolve(host).catch(() => {
				throw new PinnedHttpError("network", `cannot resolve ${host}`, true);
			});
	if (addresses.length === 0) {
		throw new PinnedHttpError("network", `cannot resolve ${host}`, true);
	}
	if (!allowPrivate) {
		const blocked = addresses.find((item) => isPrivateHost(item.address));
		if (blocked || isPrivateHost(host)) {
			throw new PinnedHttpError(
				"blocked",
				`${host} resolves to a private address`,
				false,
			);
		}
	}
	return addresses[0];
}

export interface PinnedRequest {
	url: string;
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
	headers?: Record<string, string>;
	body?: string | Buffer;
	allowPrivate: boolean;
	timeoutMs: number;
	maxResponseBytes: number;
	/**
	 * Past `maxResponseBytes`: keep the first bytes (`truncate`, e.g. an
	 * error body) or fail with `too_large` (downloads that must be whole).
	 */
	overflow?: "truncate" | "error";
}

export interface PinnedResponse {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: Buffer;
	truncated: boolean;
}

/**
 * One request through a connection pinned to the checked address. Plain
 * http needs `allowPrivate` (private or test endpoints only).
 */
export async function pinnedRequest(
	spec: PinnedRequest,
): Promise<PinnedResponse> {
	const url = new URL(spec.url);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new PinnedHttpError("blocked", "unsupported URL scheme", false);
	}
	if (url.protocol === "http:" && !spec.allowPrivate) {
		throw new PinnedHttpError(
			"blocked",
			"plain http needs private network",
			false,
		);
	}
	const pinned = await resolvePinned(url.hostname, spec.allowPrivate);
	const pinnedLookup: LookupFunction = (_hostname, opts, callback) => {
		if (opts?.all) {
			(
				callback as unknown as (error: null, addresses: PinnedAddress[]) => void
			)(null, [pinned]);
		} else {
			callback(null, pinned.address, pinned.family);
		}
	};
	const client = url.protocol === "https:" ? https : http;
	const overflow = spec.overflow ?? "truncate";
	return new Promise((resolve, reject) => {
		const request = client.request(
			url,
			{
				method: spec.method,
				headers: {
					...spec.headers,
					...(spec.body !== undefined
						? { "content-length": String(Buffer.byteLength(spec.body)) }
						: {}),
				},
				lookup: pinnedLookup,
				// One fresh connection per request: the check below sees it connect.
				agent: false,
				timeout: spec.timeoutMs,
			},
			(response) => {
				const chunks: Buffer[] = [];
				let size = 0;
				let truncated = false;
				response.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size <= spec.maxResponseBytes) {
						chunks.push(chunk);
						return;
					}
					if (overflow === "error") {
						request.destroy(
							new PinnedHttpError("too_large", "response too large", false),
						);
						return;
					}
					if (!truncated) {
						const room = spec.maxResponseBytes - (size - chunk.length);
						if (room > 0) chunks.push(chunk.subarray(0, room));
						truncated = true;
					}
				});
				response.on("end", () =>
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks),
						truncated,
					}),
				);
				response.on("error", (error) =>
					reject(
						error instanceof PinnedHttpError
							? error
							: new PinnedHttpError("network", error.message, true),
					),
				);
			},
		);
		// Runtimes that ignore `lookup` (Bun) resolve again: verify the address
		// actually connected to, so a DNS rebind can't reach a private host.
		request.on("socket", (socket) => {
			const verify = () => {
				const remote = normalizeAddress(socket.remoteAddress ?? "");
				if (
					remote !== normalizeAddress(pinned.address) &&
					!spec.allowPrivate &&
					(remote === "" || isPrivateHost(remote))
				) {
					request.destroy(
						new PinnedHttpError(
							"blocked",
							"connected to a private address",
							false,
						),
					);
				}
			};
			if (socket.remoteAddress) verify();
			else socket.once("connect", verify);
		});
		const timer = setTimeout(() => {
			request.destroy(new PinnedHttpError("timeout", "timed out", true));
		}, spec.timeoutMs);
		request.on("timeout", () =>
			request.destroy(new PinnedHttpError("timeout", "timed out", true)),
		);
		request.on("error", (error) => {
			clearTimeout(timer);
			reject(
				error instanceof PinnedHttpError
					? error
					: new PinnedHttpError("network", error.message, true),
			);
		});
		request.on("close", () => clearTimeout(timer));
		request.end(spec.body);
	});
}

/**
 * Whether `host` matches one of `patterns`: exact names, or `*.suffix`
 * (one or more labels before the suffix, never the bare suffix).
 */
export function hostMatches(
	host: string,
	patterns: readonly string[],
): boolean {
	const name = host.toLowerCase().replace(/\.$/, "");
	return patterns.some((raw) => {
		const pattern = raw.toLowerCase();
		if (pattern.startsWith("*.")) {
			const suffix = pattern.slice(1);
			return name.endsWith(suffix) && name.length > suffix.length;
		}
		return name === pattern;
	});
}
