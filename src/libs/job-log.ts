export const MAX_LOG_LINE_LENGTH = TEXT_LIMITS.logLine;

/** `[HH:MM:SS] message` in UTC. */
export function formatLogLine(message: string, date = new Date()): string {
	const line = `[${date.toISOString().substring(11, 19)}] ${message}`;
	return line.length > MAX_LOG_LINE_LENGTH
		? `${line.slice(0, MAX_LOG_LINE_LENGTH)}…`
		: line;
}

/**
 * Split a streamed chunk into complete lines. Returns the lines and the
 * unterminated remainder to prepend to the next chunk.
 */
export function splitLogChunk(
	pending: string,
	chunk: string,
): { lines: string[]; rest: string } {
	const parts = (pending + chunk).replace(/\r\n/g, "\n").split("\n");
	const rest = parts.pop() ?? "";
	return {
		lines: parts.map(lastProgressFrame).filter((line) => line.trim() !== ""),
		rest,
	};
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/** A bare CR redraws the line (progress bars): keep only the last frame. */
export function lastProgressFrame(line: string): string {
	const frames = line.split("\r").filter((frame) => frame.trim() !== "");
	return (frames.at(-1) ?? "").replace(ANSI, "").trimEnd();
}

/** Split a chunk of command output into clean log lines. */
export function logLinesFrom(text: string): string[] {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map(lastProgressFrame)
		.filter((line) => line.trim() !== "");
}

/**
 * Drops a line identical to the previous one (Docker Compose prints each
 * progress state on stdout and stderr, so every line arrived twice).
 */
export function createLineDeduper(): (line: string) => boolean {
	let previous: string | null = null;
	return (line) => {
		if (line === previous) return false;
		previous = line;
		return true;
	};
}

/** Encode one Server-Sent Event frame. */
export function encodeSSE(event: string, data: unknown, id?: number): string {
	const payload = JSON.stringify(data) ?? "null";
	const idLine = id === undefined ? "" : `id: ${id}\n`;
	return `${idLine}event: ${event}\ndata: ${payload}\n\n`;
}

export function parseLastEventId(value: string | null | undefined): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export type LogLevel = "error" | "warning" | "success" | "info";

/** Keywords that mark a job output line when no level pattern matches. */
const LEVEL_KEYWORDS: { level: LogLevel; test: (text: string) => boolean }[] = [
	{
		level: "error",
		test: (text) => text.includes("error") || text.includes("failed"),
	},
	{ level: "warning", test: (text) => text.startsWith("warning") },
	{
		level: "success",
		test: (text) => text.includes("success") || text.includes("succeeded"),
	},
];

/**
 * `[HH:MM:SS] message` of a job log: its time, text and level (a level
 * pattern from `#/config/log-formats.ts`, else keywords, else info).
 */
export function parseLogLine(line: string): {
	time?: string;
	message: string;
	level: LogLevel;
} {
	const match = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)$/s);
	const message = match?.[2] ?? line;
	const normalized = message.toLowerCase();
	const level =
		detectLogLevel(message) ??
		LEVEL_KEYWORDS.find((entry) => entry.test(normalized))?.level ??
		"info";
	return { time: match?.[1], message, level };
}

import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { detectLogLevel } from "#/libs/log-level.ts";
