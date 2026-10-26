import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import tls from "node:tls";
import type { CheckDetail } from "#/config/check-details.ts";
import { AppError } from "#/utils/error.ts";
import type { TunnelState } from "../tunnel";

type CheckStatus = "unknown" | "ok" | "warning" | "error";

interface DomainCheckInput {
	host: string;
	https: boolean;
	/** Public IPs of the server the app runs on. */
	serverIps: string[];
	timeoutMs: number;
	expiryWarningDays: number;
	/** Served through the server's Cloudflare Tunnel (no A record to check). */
	viaTunnel?: boolean;
	/** Connector state of the server's tunnel (when viaTunnel). */
	tunnelState?: TunnelState;
}

export interface DomainCheckResult {
	status: CheckStatus;
	/** Code + params, rendered in the viewer's locale (#/config/check-details.ts). */
	message: CheckDetail;
}

/**
 * Domain checker registry. Each checker fills one status column; add a
 * checker = add an entry (and a column/field if it reports something new).
 */
export interface DomainChecker {
	/** Key in `domains.checks`; must stay stable. */
	id: string;
	/** Skip (and clear) the check when false, e.g. cert for HTTP-only routes. */
	appliesTo?(input: DomainCheckInput): boolean;
	run(input: DomainCheckInput): Promise<DomainCheckResult>;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(new AppError("COMMAND_TIMEOUT", { duration: { $ms: ms } })),
					ms,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export function evaluateDns(
	resolved: string[],
	serverIps: string[],
): DomainCheckResult {
	if (resolved.length === 0) {
		return { status: "error", message: { code: "dns_no_record" } };
	}
	const matching = resolved.filter((ip) => serverIps.includes(ip));
	const list = resolved.join(", ");
	if (serverIps.length === 0) {
		return {
			status: "warning",
			message: { code: "dns_ip_unknown", params: { resolved: list } },
		};
	}
	if (matching.length === resolved.length) {
		return {
			status: "ok",
			message: { code: "dns_ok", params: { resolved: list } },
		};
	}
	if (matching.length > 0) {
		return {
			status: "warning",
			message: {
				code: "dns_partial",
				params: { resolved: list, matching: matching.join(", ") },
			},
		};
	}
	return {
		status: "error",
		message: {
			code: "dns_mismatch",
			params: { resolved: list, expected: serverIps.join(", ") },
		},
	};
}

export const dnsChecker: DomainChecker = {
	id: "dns",
	// A tunnel hostname is a CNAME to Cloudflare: no A record to compare.
	appliesTo: (input) => !input.viaTunnel,
	async run(input) {
		const lookup = async (fn: () => Promise<string[]>) => {
			try {
				return await withTimeout(fn(), input.timeoutMs);
			} catch {
				return [];
			}
		};
		const [v4, v6] = await Promise.all([
			lookup(() => dns.resolve4(input.host)),
			lookup(() => dns.resolve6(input.host)),
		]);
		return evaluateDns([...v4, ...v6], input.serverIps);
	},
};

interface PeerCertificateInfo {
	issuer: string;
	validTo: Date;
	authorized: boolean;
	authorizationError?: string;
}

export function evaluateCertificate(
	cert: PeerCertificateInfo,
	now: Date,
	warningDays: number,
): DomainCheckResult {
	const days = Math.floor(
		(cert.validTo.getTime() - now.getTime()) / 86_400_000,
	);
	const expiresAt = cert.validTo.toISOString();
	if (days < 0) {
		return {
			status: "error",
			message: { code: "cert_expired", params: { expiresAt } },
		};
	}
	if (!cert.authorized) {
		const selfSigned = /TRAEFIK DEFAULT CERT/i.test(cert.issuer);
		return {
			status: "error",
			message: selfSigned
				? { code: "cert_default" }
				: {
						code: "cert_untrusted",
						params: {
							issuer: cert.issuer,
							error: cert.authorizationError ?? "?",
						},
					},
		};
	}
	if (/STAGING|Fake LE/i.test(cert.issuer)) {
		return {
			status: "warning",
			message: { code: "cert_staging", params: { issuer: cert.issuer } },
		};
	}
	if (days < warningDays) {
		return {
			status: "warning",
			message: {
				code: "cert_expiring",
				params: { issuer: cert.issuer, expiresAt, days },
			},
		};
	}
	return {
		status: "ok",
		message: { code: "cert_ok", params: { issuer: cert.issuer, expiresAt } },
	};
}

const certChecker: DomainChecker = {
	id: "cert",
	appliesTo: (input) => input.https,
	async run(input) {
		try {
			const cert = await withTimeout(
				new Promise<PeerCertificateInfo>((resolve, reject) => {
					const socket = tls.connect({
						host: input.host,
						port: 443,
						servername: isIP(input.host) ? undefined : input.host,
						rejectUnauthorized: false,
					});
					socket.once("secureConnect", () => {
						const peer = socket.getPeerCertificate();
						const issuer = [peer.issuer?.O, peer.issuer?.CN]
							.filter(Boolean)
							.join(" ");
						resolve({
							issuer: issuer || "?",
							validTo: new Date(peer.valid_to),
							authorized: socket.authorized,
							authorizationError: socket.authorizationError
								? String(socket.authorizationError)
								: undefined,
						});
						socket.end();
					});
					socket.once("error", reject);
				}),
				input.timeoutMs,
			);
			return evaluateCertificate(cert, new Date(), input.expiryWarningDays);
		} catch (error) {
			return {
				status: "error",
				message: {
					code: "cert_unreachable",
					params: {
						message: {
							$error: {
								code: error instanceof AppError ? error.code : null,
								params:
									error instanceof AppError
										? (error.params as Record<string, never>)
										: null,
								text: error instanceof Error ? error.message : String(error),
							},
						},
					},
				},
			};
		}
	},
};

/** Tunnel connector state, in place of the DNS check for tunnel domains. */
function evaluateTunnel(state: TunnelState | undefined): DomainCheckResult {
	switch (state) {
		case "connected":
			return { status: "ok", message: { code: "tunnel_connected" } };
		case "connecting":
			return { status: "warning", message: { code: "tunnel_connecting" } };
		case "failing":
			return { status: "error", message: { code: "tunnel_failing" } };
		default:
			return { status: "error", message: { code: "tunnel_stopped" } };
	}
}

const tunnelChecker: DomainChecker = {
	id: "tunnel",
	appliesTo: (input) => !!input.viaTunnel,
	run: async (input) => evaluateTunnel(input.tunnelState),
};

export const domainCheckers: DomainChecker[] = [
	dnsChecker,
	tunnelChecker,
	certChecker,
];
