/**
 * Literal IP classification for SSRF guards (client-safe, no node APIs).
 * Addresses are parsed, not pattern-matched, so every textual form of an
 * address (IPv4-mapped/compatible IPv6, hex, NAT64...) is checked as the
 * IPv4 it reaches.
 */

/** Dotted-quad IPv4 → 4 bytes, or null. */
function parseIPv4(text: string): number[] | null {
	const parts = text.split(".");
	if (parts.length !== 4) return null;
	const bytes = parts.map((part) =>
		/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN,
	);
	return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : null;
}

/** IPv6 (incl. `::`, embedded IPv4, zone id) → 8 hextets, or null. */
export function parseIPv6(text: string): number[] | null {
	let value = text.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
	if (!value.includes(":")) return null;
	// Embedded IPv4 tail → two hextets.
	const tail = value.match(/:(\d+\.\d+\.\d+\.\d+)$/);
	if (tail) {
		const v4 = parseIPv4(tail[1]);
		if (!v4) return null;
		value = `${value.slice(0, -tail[1].length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
	}
	const halves = value.split("::");
	if (halves.length > 2) return null;
	const parse = (part: string) =>
		part === ""
			? []
			: part
					.split(":")
					.map((group) =>
						/^[0-9a-f]{1,4}$/i.test(group)
							? Number.parseInt(group, 16)
							: Number.NaN,
					);
	const head = parse(halves[0]);
	const rest = halves.length === 2 ? parse(halves[1]) : [];
	if ([...head, ...rest].some(Number.isNaN)) return null;
	if (halves.length === 1) return head.length === 8 ? head : null;
	const fill = 8 - head.length - rest.length;
	if (fill < 1) return null;
	return [...head, ...Array(fill).fill(0), ...rest];
}

type V4Range = [number[], number];
const V4_BLOCKED: V4Range[] = [
	[[0, 0, 0, 0], 8], // "this network"
	[[10, 0, 0, 0], 8],
	[[100, 64, 0, 0], 10], // CGNAT
	[[127, 0, 0, 0], 8],
	[[169, 254, 0, 0], 16], // link-local, cloud metadata
	[[172, 16, 0, 0], 12],
	[[192, 0, 0, 0], 24], // IETF protocol assignments
	[[192, 0, 2, 0], 24], // documentation
	[[192, 88, 99, 0], 24], // 6to4 relay
	[[192, 168, 0, 0], 16],
	[[198, 18, 0, 0], 15], // benchmarking
	[[198, 51, 100, 0], 24],
	[[203, 0, 113, 0], 24],
	[[224, 0, 0, 0], 4], // multicast
	[[240, 0, 0, 0], 4], // reserved + broadcast
];

const v4ToInt = (bytes: number[]) =>
	((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;

function isBlockedIPv4(bytes: number[]): boolean {
	const value = v4ToInt(bytes);
	return V4_BLOCKED.some(([base, bits]) => {
		const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
		return (value & mask) === (v4ToInt(base) & mask);
	});
}

/** IPv4 an IPv6 address reaches (mapped, compatible, NAT64, 6to4), if any. */
function embeddedIPv4(h: number[]): number[] | null {
	const v4 = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
	const zeros = (from: number, to: number) =>
		h.slice(from, to).every((group) => group === 0);
	if (zeros(0, 5) && h[5] === 0xffff) return v4(h[6], h[7]); // ::ffff:a.b.c.d
	if (zeros(0, 4) && h[4] === 0xffff && h[5] === 0) return v4(h[6], h[7]); // SIIT ::ffff:0:a.b.c.d
	if (zeros(0, 6) && (h[6] !== 0 || h[7] > 1)) return v4(h[6], h[7]); // ::a.b.c.d
	if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) return v4(h[6], h[7]); // NAT64
	if (h[0] === 0x2002) return v4(h[1], h[2]); // 6to4
	return null;
}

function isBlockedIPv6(h: number[]): boolean {
	const embedded = embeddedIPv4(h);
	if (embedded) return isBlockedIPv4(embedded);
	if (h.every((group) => group === 0)) return true; // ::
	if (h.slice(0, 7).every((group) => group === 0) && h[7] === 1) return true; // ::1
	if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
	if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	if ((h[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (old)
	if ((h[0] & 0xff00) === 0xff00) return true; // multicast
	if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
	if (h[0] === 0x0100 && h.slice(1, 4).every((group) => group === 0))
		return true; // discard
	return false;
}

/**
 * True for hosts that must not be reached without "private network":
 * loopback, private, link-local, CGNAT, multicast, reserved, documentation
 * ranges in any IPv4/IPv6 notation, and `localhost` names. Other names are
 * resolved and checked again at connect time.
 */
export function isPrivateHost(hostname: string): boolean {
	const host = hostname
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "")
		.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	const v4 = parseIPv4(host);
	if (v4) return isBlockedIPv4(v4);
	const v6 = parseIPv6(host);
	if (v6) return isBlockedIPv6(v6);
	// Other numeric forms (e.g. "2130706433", "0x7f.1"): refuse outright.
	return /^[0-9.]+$/.test(host) || /^0x/i.test(host);
}
