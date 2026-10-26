import { createHash } from "node:crypto";
import { DOCKER_LABELS, labelValueTemplate } from "#/config/identifiers.ts";
import type { TunnelState } from "#/features/servers/schema.ts";
import { shellQuote as q } from "./executor";

/**
 * Cloudflare Tunnel connector (token-based, "remotely managed" tunnel): a
 * `cloudflared` container on nitrobase-network. Public hostnames are
 * configured in the Cloudflare dashboard and point at
 * `http://<traefik container>:80`; Nitrobase never calls the Cloudflare API.
 * The token is passed through a 0600 env file, never on a command line.
 * Pure command builders (tested).
 */

export interface TunnelSettings {
	container: string;
	image: string;
	network: string;
	envFile: string;
	metricsPort: number;
}

/**
 * A connector token is base64 of `{"a": account, "t": tunnel id, "s":
 * secret}`. Checked before storing so typos fail early.
 */
export function isTunnelToken(value: string): boolean {
	const token = value.trim();
	if (!/^[A-Za-z0-9+/=_-]{60,4096}$/.test(token)) return false;
	try {
		const json = JSON.parse(
			Buffer.from(
				token.replace(/-/g, "+").replace(/_/g, "/"),
				"base64",
			).toString("utf8"),
		) as Record<string, unknown>;
		return ["a", "t", "s"].every(
			(key) =>
				typeof json[key] === "string" && (json[key] as string).length > 0,
		);
	} catch {
		return false;
	}
}

/** `TUNNEL_TOKEN=...` env file content (cloudflared reads it). */
export function tunnelEnvFile(token: string): string {
	return `TUNNEL_TOKEN=${token.trim()}\n`;
}

/** Changes when the container must be recreated (image, token, metrics). */
export function tunnelConfigHash(settings: TunnelSettings, token: string) {
	return createHash("sha256")
		.update(settings.image)
		.update("\0")
		.update(settings.network)
		.update("\0")
		.update(String(settings.metricsPort))
		.update("\0")
		.update(token.trim())
		.digest("hex")
		.slice(0, 16);
}

/**
 * Converge the connector: keep a running container with the same config
 * hash, else pull first (a registry failure leaves the old one running),
 * then replace it.
 */
export function tunnelUpScript(settings: TunnelSettings, hash: string): string {
	const container = q(settings.container);
	const image = q(settings.image);
	return `
		set -e
		current=$(docker inspect -f '{{.State.Running}} ${labelValueTemplate("configHash")}' ${container} 2>/dev/null || true)
		if [ "$current" = "true ${hash}" ]; then echo "unchanged"; exit 0; fi
		docker pull -q ${image} >/dev/null
		docker rm -f ${container} >/dev/null 2>&1 || true
		docker run -d \\
			--name ${container} \\
			--restart unless-stopped \\
			--network ${q(settings.network)} \\
			--label ${DOCKER_LABELS.configHash}=${hash} \\
			--env-file ${q(settings.envFile)} \\
			${image} tunnel --no-autoupdate --metrics 0.0.0.0:${Math.floor(settings.metricsPort)} run >/dev/null
		echo "started"
	`;
}

/** Remove the connector and its token file. */
export function tunnelDownScript(settings: TunnelSettings): string {
	return `docker rm -f ${q(settings.container)} >/dev/null 2>&1 || true; rm -f -- ${q(settings.envFile)}`;
}

/**
 * One line: `state=<docker state> restarts=<n> ready=<http code>
 * errors=<n>`. `/ready` of cloudflared's metrics server answers 200 once a
 * connection to the Cloudflare edge is registered, 503 before; `errors`
 * counts connection/registration failures logged in the last two minutes
 * (a wrong or revoked token keeps failing there without the container
 * restarting).
 */
export function tunnelStatusScript(
	settings: TunnelSettings,
	probeImage: string,
): string {
	const container = q(settings.container);
	return [
		`state=$(docker inspect -f '{{.State.Status}}' ${container} 2>/dev/null || echo missing)`,
		`restarts=$(docker inspect -f '{{.RestartCount}}' ${container} 2>/dev/null || echo 0)`,
		`ready=$( [ "$state" = running ] && docker run --rm --network ${q(settings.network)} ${q(probeImage)} -s -o /dev/null -w '%{http_code}' --max-time 5 ${q(`http://${settings.container}:${Math.floor(settings.metricsPort)}/ready`)} 2>/dev/null || echo 0)`,
		`errors=$(docker logs --since 2m ${container} 2>&1 | grep -c -E 'Unauthorized|Register tunnel error|Serve tunnel error|failed to serve tunnel connection' || true)`,
		'echo "state=$state restarts=$restarts ready=$ready errors=$errors"',
	].join("\n");
}

export type { TunnelState };

/** Interpret `tunnelStatusScript` output. */
export function parseTunnelStatus(output: string): {
	state: TunnelState;
	restarts: number;
} {
	const values = Object.fromEntries(
		output
			.trim()
			.split(/\s+/)
			.map((pair) => pair.split("=") as [string, string]),
	);
	const restarts = Number(values.restarts) || 0;
	if (values.state === "missing" || !values.state) {
		return { state: "stopped", restarts };
	}
	if (values.ready === "200") return { state: "connected", restarts };
	if (
		values.state === "restarting" ||
		restarts > 0 ||
		(Number(values.errors) || 0) > 0
	) {
		return { state: "failing", restarts };
	}
	if (values.state === "running") return { state: "connecting", restarts };
	return { state: "stopped", restarts };
}
