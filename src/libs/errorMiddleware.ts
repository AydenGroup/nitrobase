import { createMiddleware } from "@tanstack/react-start";
import { z } from "zod";
import { i18nMiddleware } from "#/libs/i18n.ts";
import { AppError, getAppErrorMessage } from "#/utils/error.ts";

/**
 * Global server-function middleware (registered in start.ts) that turns
 * thrown errors into client-safe messages: AppErrors become localized
 * text; anything else (database errors, internal invariants, raw tool
 * output) a generic translated message, with the raw text only in
 * development (the i18n rulebook, Rule 4).
 */
export const errorMiddleware = createMiddleware({ type: "function" })
	.middleware([i18nMiddleware])
	.server(async ({ next, context }) => {
		try {
			return await next();
		} catch (error) {
			// The client only receives `message`, so localize it here, in the
			// request's locale.
			if (error instanceof AppError) {
				throw new Error(getAppErrorMessage(context.i18n, error));
			}
			// Database errors carry SQL and parameters: never send them to the client.
			if (isDatabaseError(error)) {
				console.error("[server] database error", error);
				throw new Error(context.i18n._("Something went wrong"));
			}
			// Redirects, not-found and other router signals pass through, and
			// schema issues (zod, messages built with the request's i18n): the
			// form shows them under their fields.
			if (!(error instanceof Error) || error instanceof z.ZodError) throw error;
			console.error("[server] unexpected error", error);
			if (process.env.NODE_ENV !== "production") throw error;
			throw new Error(context.i18n._("Something went wrong"));
		}
	});

function isDatabaseError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code =
		(error as { code?: unknown }).code ??
		(error.cause as { code?: unknown } | undefined)?.code;
	return (
		error.name === "DrizzleQueryError" ||
		error.message.startsWith("Failed query:") ||
		(typeof code === "string" && /^[0-9A-Z]{5}$/.test(code))
	);
}
