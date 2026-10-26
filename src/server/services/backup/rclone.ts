import path from "node:path";
import type { RcloneRemote } from "#/config/backup-drivers.ts";
import type { JobLogger } from "#/features/deployments/deployments.server.ts";
import type { ErrorCode } from "#/libs/error-codes.ts";
import { shellQuote as q } from "#/server/services/executor.ts";
import { TemplateError } from "#/server/services/templates/naming.ts";
import { AppError, coded, internalError } from "#/utils/error.ts";

/**
 * rclone runs in a throwaway container. Credentials only ever live in an
 * rclone.conf written 0600 into the job's staging folder (removed after the
 * job) and mounted read-only: never in argv, env or logs.
 */

const REMOTE_NAME = "dest";
const CONF_IN_CONTAINER = "/config/rclone/rclone.conf";
const KEY_PATTERN = /^[a-z0-9_]+$/;

/** rclone.conf with one `[dest]` section. */
export function renderRcloneConfig(remote: RcloneRemote): string {
	return renderRcloneSections({ [REMOTE_NAME]: remote.section });
}

const SECTION_PATTERN = /^[a-z][a-z0-9_]*$/;

/** rclone.conf with one section per named remote (e.g. a copy's two ends). */
export function renderRcloneSections(
	sections: Record<string, Record<string, string>>,
): string {
	const lines: string[] = [];
	for (const [name, section] of Object.entries(sections)) {
		if (!SECTION_PATTERN.test(name)) {
			throw new TemplateError("RCLONE_OPTION_INVALID", { option: name });
		}
		lines.push(`[${name}]`);
		for (const [key, value] of Object.entries(section)) {
			if (!KEY_PATTERN.test(key) || /[\r\n\0]/.test(value)) {
				throw new TemplateError("RCLONE_OPTION_INVALID", { option: key });
			}
			lines.push(`${key} = ${value}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

/** Destination object path `<base>/<key>` (no traversal, no absolute key). */
export function remotePath(remote: RcloneRemote, key: string): string {
	if (
		!key ||
		key.startsWith("/") ||
		path.posix.normalize(key) !== key ||
		key.split("/").some((part) => part === ".." || part === "") ||
		!/^[A-Za-z0-9_./-]+$/.test(key)
	) {
		throw internalError(`Invalid backup key "${key}"`);
	}
	return `${REMOTE_NAME}:${remote.base ? `${remote.base}/` : ""}${key}`;
}

export interface RcloneRun {
	image: string;
	/** Host path of the 0600 rclone.conf. */
	confPath: string;
	remote: RcloneRemote;
	/** Host folder mounted at /work (staging), if any. */
	workDir?: string;
	/** Read-only work mount (uploads). */
	workReadOnly?: boolean;
	/** Docker network to join (e.g. to reach an app's internal endpoint). */
	network?: string;
	args: string[];
}

const ARG_PATTERN = /^[A-Za-z0-9_./:=@+-]+$/;

/** `docker run … rclone <args>`; every argument is validated and quoted. */
export function rcloneCommand(run: RcloneRun): string {
	for (const arg of run.args) {
		if (!ARG_PATTERN.test(arg)) {
			throw internalError(`Invalid rclone argument "${arg}"`);
		}
	}
	const mounts = [`-v ${q(`${run.confPath}:${CONF_IN_CONTAINER}:ro`)}`];
	if (run.workDir) {
		mounts.push(
			`-v ${q(`${run.workDir}:/work${run.workReadOnly ? ":ro" : ""}`)}`,
		);
	}
	if (run.remote.mount) {
		mounts.push(
			`-v ${q(`${run.remote.mount.host}:${run.remote.mount.container}`)}`,
		);
	}
	return [
		// --init: rclone isn't PID 1, so TERM (abort, timeout) stops it.
		"docker run --rm -i --init",
		...(run.network ? [`--network ${q(run.network)}`] : []),
		...mounts,
		q(run.image),
		"--config",
		CONF_IN_CONTAINER,
		...run.args.map(q),
	].join(" ");
}

/** Secret values to scrub from any output that reaches logs or users. */
export function redactor(secrets: string[]): (text: string) => string {
	const values = secrets.filter((value) => value.length >= 4);
	return (text) =>
		values.reduce((out, value) => out.split(value).join("[redacted]"), text);
}

/** Known rclone failure kinds (UI labels: `rcloneErrorLabels`). */
export type RcloneErrorKind =
	| "auth"
	| "not_found"
	| "permission"
	| "network"
	| "tls"
	| "unknown";

const ERROR_PATTERNS: [RcloneErrorKind, RegExp][] = [
	[
		"auth",
		/SignatureDoesNotMatch|InvalidAccessKeyId|InvalidToken|\b403\b|Forbidden|AccessDenied|Unauthorized|\b401\b/i,
	],
	[
		"not_found",
		/NoSuchBucket|bucket.*not (?:exist|found)|directory not found|\b404\b/i,
	],
	["permission", /permission denied|read-only file system/i],
	["tls", /x509|certificate|tls:|handshake failure/i],
	[
		"network",
		/connection refused|no such host|i\/o timeout|network is unreachable|dial tcp|context deadline exceeded/i,
	],
];

/**
 * Short classification of rclone stderr plus the distinct log lines
 * (rclone retries 3×, printing the same error each time). The raw detail
 * stays available behind "Details".
 */
export function summarizeRcloneError(stderr: string): {
	kind: RcloneErrorKind;
	detail: string;
} {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const raw of stderr.split("\n")) {
		// Drop the timestamp/level prefix so retries collapse into one line.
		const line = raw
			// Per-request ids differ between retries: drop them to dedupe.
			.replace(
				/\b(request ?id|requestid|host ?id|x-amz-(?:request-)?id(?:-2)?)\s*[:=]\s*"?[\w+/=-]+"?,?/gi,
				"",
			)
			.replace(/\s{2,}/g, " ")
			.replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s+/, "")
			.replace(/^(ERROR|NOTICE|INFO)\s*:\s*/, "")
			.replace(/Attempt \d+\/\d+ failed with \d+ errors and: /, "")
			.trim();
		if (!line || seen.has(line)) continue;
		seen.add(line);
		lines.push(line);
	}
	const detail = lines.join("\n");
	const kind =
		ERROR_PATTERNS.find(([, pattern]) => pattern.test(detail))?.[0] ??
		"unknown";
	return { kind, detail };
}

/** Coded reason per kind (also the UI's `rcloneErrorLabels`). */
const rcloneKindCodes = {
	auth: "RCLONE_AUTH",
	not_found: "RCLONE_NOT_FOUND",
	permission: "RCLONE_PERMISSION",
	network: "RCLONE_NETWORK",
	tls: "RCLONE_TLS",
	unknown: "RCLONE_UNKNOWN",
} as const satisfies Record<RcloneErrorKind, ErrorCode>;

/**
 * A failed rclone step as a short coded error, logging the distinct raw
 * lines under "Details" (the job log keeps them; the job/app error stays
 * short).
 */
export function rcloneFailure(
	step: "upload" | "download",
	stderr: string,
	log: JobLogger,
): AppError {
	const { kind, detail } = summarizeRcloneError(stderr);
	if (detail) {
		log.event("backup.rclone_details");
		log.log(detail);
	}
	return new AppError(
		step === "upload" ? "RCLONE_UPLOAD_FAILED" : "RCLONE_DOWNLOAD_FAILED",
		{ reason: { $error: coded(rcloneKindCodes[kind]) } },
	);
}
