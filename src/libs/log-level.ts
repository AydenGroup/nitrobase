import {
	jsonLogFields,
	type LogLevelPattern,
	logLevelPatterns,
	logLevelWords,
	numericLogLevels,
} from "#/config/log-formats.ts";
import type { LogLevel } from "#/libs/job-log.ts";

/**
 * Level detection for raw log lines (container and command output), driven
 * by the data tables in `#/config/log-formats.ts`. Pure; client-safe.
 */

export interface DetectedLogLine {
	/** The line as received. */
	raw: string;
	/** `HH:MM:SS` shown before the line (from a Docker or JSON timestamp). */
	time?: string;
	/** Full timestamp the time was taken from. */
	timestamp?: string;
	/** Compose service prefix (`web-1 | …`), when asked for. */
	source?: string;
	/** Text to show: the JSON `msg`/`message`, else the line without prefixes. */
	message: string;
	/** Null when the line names no level. */
	level: LogLevel | null;
	/** Whether the line was a JSON object (the message was extracted). */
	json: boolean;
}

const escapeRegex = (word: string) =>
	word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface CompiledPattern {
	regex: RegExp;
	words: Record<string, LogLevel>;
	level?: LogLevel;
}

function compile(pattern: LogLevelPattern): CompiledPattern {
	const table = pattern.words ?? logLevelWords;
	const words = Object.keys(table)
		.map((word) => (pattern.upper ? word.toUpperCase() : word))
		.sort((a, b) => b.length - a.length)
		.map(escapeRegex);
	const source = pattern.source.replace("{level}", words.join("|"));
	const lower = Object.fromEntries(
		Object.entries(table).map(([word, level]) => [word.toLowerCase(), level]),
	);
	return {
		regex: new RegExp(source, pattern.upper ? "" : "i"),
		words: lower,
		level: pattern.level,
	};
}

let compiled: CompiledPattern[] | null = null;
const patterns = () => {
	compiled ??= logLevelPatterns.map(compile);
	return compiled;
};

/** Level named by a level value (`"WARN"`, `"warning"`, `50`, `"50"`). */
export function levelFromValue(value: unknown): LogLevel | null {
	const numeric =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d+$/.test(value.trim())
				? Number(value)
				: null;
	if (numeric !== null) {
		return (
			numericLogLevels.find((entry) => numeric >= entry.min)?.level ?? null
		);
	}
	if (typeof value !== "string") return null;
	const word = value.trim().toLowerCase();
	return Object.hasOwn(logLevelWords, word) ? logLevelWords[word] : null;
}

/** Level of a text line from the pattern table; null when none matches. */
export function detectLogLevel(text: string): LogLevel | null {
	for (const pattern of patterns()) {
		const match = pattern.regex.exec(text);
		if (!match) continue;
		if (pattern.level) return pattern.level;
		const level = pattern.words[(match[1] ?? "").toLowerCase()];
		if (level) return level;
	}
	return null;
}

const DOCKER_TIME =
	/^(\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s?(.*)$/s;
const COMPOSE_PREFIX = /^([\w.-]+)\s*\|\s?(.*)$/s;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}[T ](\d{2}:\d{2}:\d{2})/;

function field(record: Record<string, unknown>, names: readonly string[]) {
	for (const name of names) {
		if (record[name] !== undefined && record[name] !== null)
			return record[name];
	}
	return undefined;
}

/** `HH:MM:SS` (UTC) of a JSON time value: ISO text or epoch s/ms. */
function timeOf(value: unknown): string | undefined {
	if (typeof value === "string") return ISO_TIME.exec(value)?.[1];
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		const ms = value > 1e12 ? value : value * 1000;
		return new Date(ms).toISOString().substring(11, 19);
	}
	return undefined;
}

function parseJson(text: string): Record<string, unknown> | null {
	if (!text.startsWith("{") || !text.endsWith("}")) return null;
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/**
 * Split a raw log line into time, source, message and level: strips the
 * Compose `service |` prefix (when `composePrefix`), a Docker timestamp,
 * reads JSON logs' level/message/time fields, else matches the text
 * patterns.
 */
export function detectLogLine(
	raw: string,
	options: { composePrefix?: boolean } = {},
): DetectedLogLine {
	let rest = raw;
	let source: string | undefined;
	if (options.composePrefix) {
		const prefix = COMPOSE_PREFIX.exec(rest);
		if (prefix) {
			source = prefix[1];
			rest = prefix[2];
		}
	}
	let time: string | undefined;
	let timestamp: string | undefined;
	const docker = DOCKER_TIME.exec(rest);
	if (docker) {
		timestamp = docker[1];
		time = docker[2];
		rest = docker[3];
	}
	const text = rest.trim();
	const json = parseJson(text);
	if (json) {
		const message = field(json, jsonLogFields.message);
		const level = levelFromValue(field(json, jsonLogFields.level));
		const jsonTime = field(json, jsonLogFields.time);
		return {
			raw,
			source,
			time: time ?? timeOf(jsonTime),
			timestamp:
				timestamp ?? (typeof jsonTime === "string" ? jsonTime : undefined),
			message: typeof message === "string" && message ? message : text,
			level:
				level ?? (typeof message === "string" ? detectLogLevel(message) : null),
			json: true,
		};
	}
	return {
		raw,
		source,
		time,
		timestamp,
		message: rest,
		level: detectLogLevel(text),
		json: false,
	};
}
