import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { APP_NAME } from "#/config/shared.ts";
import { type CodedValue, formatCodedValue } from "#/libs/coded.ts";
import { formatBytes, formatDate, formatNumber } from "#/libs/intl.ts";

/**
 * Human text of pre-flight and domain check results. The server returns a
 * code plus raw params (bytes, ISO dates, IPs); the client renders them in
 * the viewer's locale. Add a code = one entry in `checkDetailMessages`
 * (and in `CheckDetailParams` when it takes params).
 */
interface CheckDetailParams {
	server_not_bootstrapped: Record<never, never>;
	server_ready: { name: string };
	docker_missing: Record<never, never>;
	docker_too_old: { version: string; min: string };
	docker_version: { version: string };
	traefik_running: Record<never, never>;
	traefik_not_running: Record<never, never>;
	memory: { availableBytes: number; recommendedBytes: number };
	memory_unknown: Record<never, never>;
	disk: { freeBytes: number; requiredBytes: number };
	disk_unknown: Record<never, never>;
	probe_failed: { message: CodedValue };
	template_ok: { version: string };
	template_refused: { message: CodedValue };
	template_unchecked: { message: CodedValue };
	domain_invalid: { domain: string };
	domain_in_use: { host: string };
	domain_free: { provider: string };
	dns_no_record: Record<never, never>;
	dns_ip_unknown: { resolved: string };
	dns_ok: { resolved: string };
	dns_partial: { resolved: string; matching: string };
	dns_mismatch: { resolved: string; expected: string };
	cert_expired: { expiresAt: string };
	cert_default: Record<never, never>;
	cert_untrusted: { issuer: string; error: string };
	cert_staging: { issuer: string };
	cert_expiring: { issuer: string; expiresAt: string; days: number };
	cert_ok: { issuer: string; expiresAt: string };
	cert_unreachable: { message: CodedValue };
	tunnel_connected: Record<never, never>;
	tunnel_connecting: Record<never, never>;
	tunnel_failing: Record<never, never>;
	tunnel_stopped: Record<never, never>;
	domain_tunnel: { service: string };
	domain_tunnel_free: { provider: string };
	server_foreign: { owner: string };
	limits_none: Record<never, never>;
	limits_ok: {
		limitBytes: number;
		totalBytes: number;
		cpus: number;
		cores: number;
	};
	limits_over: {
		limitBytes: number;
		totalBytes: number;
		cpus: number;
		cores: number;
	};
}

type CheckDetailCode = keyof CheckDetailParams;

/** Serializable detail: a code and its raw params. */
export type CheckDetail = {
	[C in CheckDetailCode]: keyof CheckDetailParams[C] extends never
		? { code: C; params?: CheckDetailParams[C] }
		: { code: C; params: CheckDetailParams[C] };
}[CheckDetailCode];

const checkDetailMessages = {
	server_not_bootstrapped: msg({ id: "Server is not bootstrapped" }),
	server_ready: msg({ id: "{name} is ready" }),
	docker_missing: msg({ id: "Docker is not running" }),
	docker_too_old: msg({
		id: "Docker {version}, this template needs {min} or newer",
	}),
	docker_version: msg({ id: "Docker {version}" }),
	traefik_running: msg({ id: "Traefik is running" }),
	traefik_not_running: msg({
		id: "Traefik is not running: bootstrap the server again",
	}),
	memory: msg({ id: "{available} available, {recommended} recommended" }),
	memory_unknown: msg({ id: "Could not read free memory" }),
	disk: msg({ id: "{free} free, {required} required" }),
	disk_unknown: msg({ id: "Could not read free disk space" }),
	probe_failed: msg({ id: "Could not check the server: {message}" }),
	template_ok: msg({
		id: "Version {version} passes the compose policy",
	}),
	template_refused: msg({ id: "Deploying would fail: {message}" }),
	template_unchecked: msg({
		id: "Could not render the template to check it: {message}",
	}),
	domain_invalid: msg({ id: "{domain} is not a valid domain" }),
	domain_in_use: msg({ id: "{host} is already in use" }),
	domain_free: msg({ id: "A free {provider} domain will be generated" }),
	dns_no_record: msg({ id: "No A/AAAA record" }),
	dns_ip_unknown: msg({ id: "Resolves to {resolved}; server IP unknown" }),
	dns_ok: msg({ id: "Resolves to {resolved}" }),
	dns_partial: msg({
		id: "Resolves to {resolved}; only {matching} is this server",
	}),
	dns_mismatch: msg({
		id: "Resolves to {resolved}, expected {expected} (proxied DNS such as Cloudflare also shows here)",
	}),
	cert_expired: msg({ id: "Expired on {expiresAt}" }),
	cert_default: msg({
		id: "Traefik default certificate (Let's Encrypt not issued yet: check DNS and port 80)",
	}),
	cert_untrusted: msg({ id: "Untrusted certificate from {issuer}: {error}" }),
	cert_staging: msg({ id: "Staging certificate ({issuer})" }),
	cert_expiring: msg({
		id: "{issuer}, expires {expiresAt} ({days, plural, one {# day} other {# days}})",
	}),
	cert_ok: msg({ id: "{issuer}, valid until {expiresAt}" }),
	cert_unreachable: msg({ id: "HTTPS not reachable: {message}" }),
	tunnel_connected: msg({
		id: "Served through the Cloudflare Tunnel (connector connected)",
	}),
	tunnel_connecting: msg({
		id: "The Cloudflare Tunnel connector is starting or cannot reach Cloudflare yet",
	}),
	tunnel_failing: msg({
		id: "The Cloudflare Tunnel connector keeps restarting: check the token",
	}),
	tunnel_stopped: msg({
		id: "The Cloudflare Tunnel connector is not running on this server",
	}),
	domain_tunnel: msg({
		id: "Served through the Cloudflare Tunnel: add this hostname to the tunnel in Cloudflare (service {service})",
	}),
	domain_tunnel_free: msg({
		id: "This server is tunnel-only: a free {provider} domain is not reachable. Enter a domain on Cloudflare.",
	}),
	server_foreign: msg({
		id: "Another {appName} instance ({owner}) manages this server: deploying here is refused",
	}),
	limits_none: msg({
		id: "No memory or CPU limits on this server's apps yet",
	}),
	limits_ok: msg({
		id: "Limits of all apps here, this one included: {limit} of {total} RAM, {cpus} of {cores} CPUs",
	}),
	limits_over: msg({
		id: "Limits add up to more than the server has ({limit} of {total} RAM, {cpus} of {cores} CPUs): when every app peaks, some may be killed or throttled",
	}),
} satisfies Record<CheckDetailCode, MessageDescriptor>;

function isCheckDetailCode(value: unknown): value is CheckDetailCode {
	return typeof value === "string" && value in checkDetailMessages;
}

/** Locale formatting of raw params (bytes, dates, counts) before interpolation. */
function formatParams(
	i18n: I18n,
	params: Record<string, unknown> | undefined,
): Record<string, string | number> {
	const locale = i18n.locale;
	const out: Record<string, string | number> = { appName: APP_NAME };
	for (const [key, value] of Object.entries(params ?? {})) {
		if (typeof value === "object" && value !== null) {
			// Coded values (a nested error, a size...).
			out[key] = String(formatCodedValue(i18n, value));
			continue;
		}
		if (key.endsWith("Bytes") && typeof value === "number") {
			out[key.slice(0, -"Bytes".length)] = formatBytes(locale, value);
		} else if (key.endsWith("At") && typeof value === "string") {
			out[key] = formatDate(locale, value, { dateStyle: "medium" });
		} else if (key === "days" && typeof value === "number") {
			out[key] = value;
		} else if (typeof value === "number") {
			out[key] = formatNumber(locale, value);
		} else {
			out[key] = String(value ?? "");
		}
	}
	return out;
}

/** Translated text of a check detail. */
export function renderCheckDetail(i18n: I18n, detail: CheckDetail): string {
	return i18n._({
		...checkDetailMessages[detail.code],
		values: formatParams(
			i18n,
			detail.params as Record<string, unknown> | undefined,
		),
	});
}

/** Text of a stored check result (empty for a code this version lacks). */
export function storedCheckText(
	i18n: I18n,
	check: { message: CheckDetail },
): string {
	return isCheckDetailCode(check.message.code)
		? renderCheckDetail(i18n, check.message)
		: "";
}
