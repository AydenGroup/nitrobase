import { z } from "zod";

/** One DNS label (also a bare name resolved via /etc/hosts, e.g. `vps1`). */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * True for an SSH target host: an IPv4/IPv6 address or a hostname made of
 * valid DNS labels (single-label names allowed). Case-insensitive.
 */
export function isServerHost(value: string): boolean {
	const host = value.trim().toLowerCase();
	if (z.ipv4().safeParse(host).success || z.ipv6().safeParse(host).success) {
		return true;
	}
	return (
		host.length <= 253 && host.split(".").every((label) => LABEL.test(label))
	);
}
