import type { LogLevel } from "#/libs/job-log.ts";

/**
 * How raw log lines (container output, command output) reveal their level.
 * Data only: `#/libs/log-level.ts` applies it. Add a format by adding a
 * word, a JSON field or a pattern here, never a branch in the detector.
 */

/** Level words (lower case) → level. Shared by every text pattern. */
export const logLevelWords: Record<string, LogLevel> = {
	emerg: "error",
	emergency: "error",
	alert: "error",
	crit: "error",
	critical: "error",
	fatal: "error",
	panic: "error",
	severe: "error",
	error: "error",
	err: "error",
	eror: "error",
	warn: "warning",
	warning: "warning",
	wrn: "warning",
	notice: "info",
	info: "info",
	inf: "info",
	information: "info",
	log: "info",
	debug: "info",
	dbg: "info",
	trace: "info",
	verbose: "info",
	success: "success",
	ok: "success",
};

/** Numeric levels (pino/bunyan): first entry whose `min` the value reaches. */
export const numericLogLevels: { min: number; level: LogLevel }[] = [
	{ min: 50, level: "error" },
	{ min: 40, level: "warning" },
	{ min: 0, level: "info" },
];

/** JSON log fields, in lookup order. */
export const jsonLogFields = {
	level: [
		"level",
		"severity",
		"lvl",
		"log.level",
		"levelname",
		"loglevel",
		"@l",
	],
	message: ["msg", "message", "@m", "error_description", "error"],
	time: ["time", "timestamp", "ts", "@t", "t"],
} as const;

/**
 * A text pattern that finds a level word in a line. `{level}` in `source`
 * is replaced by the alternation of the level words (from `logLevelWords`,
 * or `words` when set); capture group 1 is the word. `upper` keeps only the
 * upper-case spelling (a bare `ERROR`/`LOG`, never prose like "log in").
 */
export interface LogLevelPattern {
	id: string;
	/** Example line (documentation and tests). */
	example: string;
	source: string;
	upper?: boolean;
	/** Own word table (e.g. glog's one-letter severities). */
	words?: Record<string, LogLevel>;
	/** Fixed level of a match (no `{level}` group). */
	level?: LogLevel;
}

/** Text patterns, first match wins. */
export const logLevelPatterns: LogLevelPattern[] = [
	{
		id: "logfmt",
		example: 'time=2026-01-02T03:04:05Z level=warn msg="disk almost full"',
		source: '(?:^|\\s)(?:level|lvl|severity)="?({level})"?(?=\\s|$)',
	},
	{
		id: "glog",
		example: "E0102 03:04:05.678901       1 controller.go:42] sync failed",
		source: "^({level})\\d{4} \\d{2}:\\d{2}:\\d{2}",
		words: { I: "info", W: "warning", E: "error", F: "error" },
		upper: true,
	},
	{
		// nginx/kong `[error]`, elixir/realtime `[info]`, `[ERROR]`.
		id: "bracket",
		example: "2026/01/02 03:04:05 [error] 1#0: *3 connect() failed",
		source: "^.{0,120}?\\[({level})\\]",
	},
	{
		// logrus text `INFO[0000]`, `WARN  message`, imgproxy `INFO   [...]`.
		id: "leading-word",
		example: "WARN[0001] retrying connection",
		source: "^({level})(?=[\\s:\\[|(]|$)",
		upper: true,
	},
	{
		// Postgres `LOG:`/`ERROR:`/`FATAL:` after its own timestamp and pid.
		id: "upper-colon",
		example: '2026-01-02 03:04:05.678 UTC [42] FATAL:  role "x" does not exist',
		source: "^.{0,120}?\\b({level}):",
		upper: true,
	},
	{
		// `level word + space` after a date/time (logback, python logging).
		id: "after-time",
		example: "2026-01-02 03:04:05,678 WARNING worker restarted",
		source: "^(?:[\\d:./,TZ+-]+\\s+){1,3}({level})\\b",
		upper: true,
	},
	{
		// `error: …`, `panic: …`, `warning: …` (Go, Node, shell tools).
		id: "colon-prefix",
		example: "panic: runtime error: index out of range",
		source: "^({level}):\\s",
	},
	{
		id: "exception",
		example: "TypeError: Cannot read properties of undefined",
		source:
			"^(?:[\\w.$]*(?:Error|Exception)(?::|$)|Traceback \\(most recent call last\\)|Unhandled(?:Promise)?Rejection)",
		level: "error",
	},
];
