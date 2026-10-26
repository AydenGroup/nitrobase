/**
 * Lengths text is clipped to before it is stored, logged or shown
 * (characters). Client-safe; use with `clip`/`clipEnd` from
 * `#/libs/format.ts`. One entry per kind of text, not per call site.
 */
export const TEXT_LIMITS = {
	/** Raw tool output kept in a coded error's `detail` (behind "Details"). */
	errorDetail: 1000,
	/** Error text stored on a row (delivery, restore, update check). */
	storedError: 2000,
	/** Client error output a console run shows. */
	consoleError: 4000,
	/** A statement or command recorded in the audit log (values hidden). */
	auditText: 500,
	/** One job log line. */
	logLine: 4000,
	/** Tail of a child process's error output kept while it runs. */
	processErrorTail: 4000,
	/** Commit message, notification title and similar one-line texts. */
	message: 500,
	/** Commit author, HTTP error body excerpt and other short labels. */
	shortText: 200,
	/** Webhook event names and other identifiers from requests. */
	identifier: 100,
	/** First line of an error shown inline (move preflight). */
	inlineError: 300,
	/** Audit meta values in the audit table cell. */
	auditCell: 80,
} as const;

/** Files of a repository listed by a checkout probe. */
export const REPOSITORY_PROBE_FILES_SHOWN = 100;
