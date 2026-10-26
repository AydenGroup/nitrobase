import { APP_ID } from "#/config/shared.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import { TemplateError } from "#/server/services/templates/naming.ts";
import { internalError } from "#/utils/error.ts";

/**
 * Server-side HTTP calls to an app's API gateway (Supabase invoke tester
 * and RPC runner, Appwrite import bootstrap). The request never leaves the managed host: a throwaway curl
 * container on the proxy network calls `http://<app>-<gateway>:<port><path>`.
 * The URL is built from validated parts only (no user-supplied host), and
 * keys/body travel in a curl config on stdin, never in argv.
 */

export function assertContainerName(container: string): string {
	if (!/^[a-z0-9][a-z0-9_.-]*$/.test(container)) {
		throw internalError(`Invalid container name "${container}"`);
	}
	return container;
}

const GATEWAY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type GatewayMethod = (typeof GATEWAY_METHODS)[number];

const PATH_PATTERN = /^\/[A-Za-z0-9._~\-/]*$/;
/** A percent-encoded query string (built by the panel, e.g. list queries). */
const QUERY_PATTERN = /^[A-Za-z0-9._~%=&+*-]+$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
/** Marks curl's write-out on stderr. */
export const WRITE_OUT_MARKER = `__${APP_ID}_http__`;

export interface GatewayRequest {
	network: string;
	image: string;
	container: string;
	port: number;
	path: string;
	/** Percent-encoded query (without `?`); never part of `path`. */
	query?: string;
	method: GatewayMethod;
	headers: Record<string, string>;
	body?: string;
	timeoutMs: number;
	maxResponseBytes: number;
}

/** Quote a value for a curl config file (double-quoted string). */
export function curlConfigString(value: string): string {
	if (value.includes("\0")) throw new TemplateError("GATEWAY_NUL");
	return `"${value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t")
		.replace(/\v/g, "\\v")}"`;
}

export function gatewayUrl(
	request: Pick<GatewayRequest, "container" | "port" | "path" | "query">,
): string {
	assertContainerName(request.container);
	if (
		!Number.isInteger(request.port) ||
		request.port < 1 ||
		request.port > 65535
	) {
		throw new TemplateError("GATEWAY_PORT_INVALID");
	}
	if (!PATH_PATTERN.test(request.path) || request.path.includes("..")) {
		throw new TemplateError("GATEWAY_PATH_INVALID", { path: request.path });
	}
	if (request.query !== undefined && !QUERY_PATTERN.test(request.query)) {
		throw new TemplateError("GATEWAY_PATH_INVALID", { path: request.query });
	}
	return `http://${request.container}:${request.port}${request.path}${request.query ? `?${request.query}` : ""}`;
}

/** curl config (stdin): URL, method, headers and body. */
export function curlConfig(request: GatewayRequest): string {
	if (!GATEWAY_METHODS.includes(request.method)) {
		throw new TemplateError("GATEWAY_METHOD_UNSUPPORTED", {
			method: request.method,
		});
	}
	const lines = [
		`url = ${curlConfigString(gatewayUrl(request))}`,
		`request = ${curlConfigString(request.method)}`,
	];
	for (const [name, value] of Object.entries(request.headers)) {
		if (!HEADER_NAME.test(name) || /[\r\n]/.test(value)) {
			throw new TemplateError("GATEWAY_HEADER_INVALID", { header: name });
		}
		lines.push(`header = ${curlConfigString(`${name}: ${value}`)}`);
	}
	if (request.body !== undefined && request.method !== "GET") {
		lines.push(`data-binary = ${curlConfigString(request.body)}`);
	}
	return `${lines.join("\n")}\n`;
}

/**
 * Throwaway curl on the proxy network. Response headers + body on stdout
 * (capped), status and timing on stderr after the marker.
 */
export function gatewayCommand(request: GatewayRequest): string {
	const seconds = Math.max(1, Math.ceil(request.timeoutMs / 1000));
	const max = Math.max(1024, Math.floor(request.maxResponseBytes));
	return [
		"docker run --rm -i",
		`--network ${q(request.network)}`,
		q(request.image),
		"-s -S -i --no-progress-meter",
		`--max-time ${seconds}`,
		`-w ${q(`%{stderr}${WRITE_OUT_MARKER}%{http_code} %{time_total}\\n`)}`,
		"-K -",
		`| head -c ${max + 1}`,
	].join(" ");
}

export interface GatewayResponse {
	status: number | null;
	headers: [string, string][];
	body: string;
	/** Seconds, from curl. */
	timeSeconds: number | null;
	truncated: boolean;
}

/** Parse `curl -i` output (skipping 1xx blocks) and the write-out line. */
export function parseGatewayResponse(
	stdout: string,
	stderr: string,
	maxResponseBytes: number,
): GatewayResponse {
	let rest = stdout;
	let headers: [string, string][] = [];
	let status: number | null = null;
	for (;;) {
		const match = /^HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n/.exec(rest);
		if (!match) break;
		const end = rest.search(/\r?\n\r?\n/);
		const block = end === -1 ? rest : rest.slice(0, end);
		rest = end === -1 ? "" : rest.slice(end).replace(/^\r?\n\r?\n/, "");
		status = Number(match[1]);
		headers = block
			.split(/\r?\n/)
			.slice(1)
			.map((line): [string, string] => {
				const colon = line.indexOf(":");
				return colon === -1
					? [line, ""]
					: [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
			})
			.filter(([name]) => name.length > 0);
		if (status >= 200 || status < 100) break;
	}
	const marker = stderr.lastIndexOf(WRITE_OUT_MARKER);
	let timeSeconds: number | null = null;
	if (marker !== -1) {
		const [code, time] = stderr
			.slice(marker + WRITE_OUT_MARKER.length)
			.trim()
			.split(/\s+/);
		const parsedCode = Number(code);
		if (status === null && parsedCode > 0) status = parsedCode;
		const parsedTime = Number(time);
		if (Number.isFinite(parsedTime)) timeSeconds = parsedTime;
	}
	const truncated = Buffer.byteLength(stdout, "utf8") > maxResponseBytes;
	return {
		status,
		headers,
		body: truncated ? rest.slice(0, maxResponseBytes) : rest,
		timeSeconds,
		truncated,
	};
}

/** curl's own error message (stderr without the write-out line). */
export function gatewayError(stderr: string): string {
	const marker = stderr.lastIndexOf(WRITE_OUT_MARKER);
	return (marker === -1 ? stderr : stderr.slice(0, marker)).trim();
}
