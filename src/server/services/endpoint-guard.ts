import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateHost } from "#/config/ip-ranges.ts";

/**
 * Save-time SSRF check of a user-supplied endpoint host (S3 endpoints,
 * webhooks, SMTP): the name must resolve, and to public addresses only,
 * unless the user enabled the private-network option. Sending still
 * resolves, checks and pins the address each time (DNS can change after
 * saving); this only rejects obviously internal endpoints early.
 */
export type EndpointVerdict = "ok" | "private" | "unresolved";

export async function checkEndpointHost(
	hostname: string,
	options: {
		allowPrivate: boolean;
		resolve?: (host: string) => Promise<{ address: string }[]>;
	},
): Promise<EndpointVerdict> {
	if (options.allowPrivate) return "ok";
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (isPrivateHost(host)) return "private";
	if (isIP(host)) return "ok";
	const resolve =
		options.resolve ??
		((name: string) => lookup(name, { all: true, verbatim: true }));
	let addresses: { address: string }[];
	try {
		addresses = await resolve(host);
	} catch {
		return "unresolved";
	}
	if (addresses.length === 0) return "unresolved";
	return addresses.some((item) => isPrivateHost(item.address))
		? "private"
		: "ok";
}

/** Host of a URL or bare host field (null when not parseable). */
export function endpointHostOf(value: unknown): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		return new URL(value).hostname || null;
	} catch {
		return /^[A-Za-z0-9.\-[\]:]+$/.test(value.trim()) ? value.trim() : null;
	}
}
