/**
 * Uncoded errors, with no imports (usable from scripts and low-level
 * modules). Everything a user can trigger is a coded AppError instead
 * (#/utils/error.ts); see the error classification in
 * src/libs/error-classification.test.ts.
 */

/**
 * An internal invariant failure: a programming error or impossible state
 * that no user input can cause (e.g. a generated name that fails its own
 * pattern). Kept in English for operators; never shown as such (the UI
 * shows a generic message). Everything a user can trigger is an AppError.
 */
export function internalError(message: string): Error {
	return new Error(message);
}

/**
 * Raw output of a tool or a third party (stderr, an HTTP body), shown as
 * is: never panel text. Panel text is an AppError.
 */
export function toolOutputError(output: string): Error {
	return new Error(output);
}
