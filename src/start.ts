import { createCsrfMiddleware, createStart } from "@tanstack/react-start";
import { i18nMiddleware } from "#/libs/i18n";
import { errorMiddleware } from "./libs/errorMiddleware";

// CSRF check, applied to server-function (RPC) requests only.
const csrfMiddleware = createCsrfMiddleware({
	filter: (ctx) => ctx.handlerType === "serverFn",
});

/**
 * TanStack Start configuration. Request middleware runs on every request
 * (CSRF check, then locale activation); function middleware wraps every
 * server function (error localization/sanitizing).
 */
export const startInstance = createStart(() => ({
	requestMiddleware: [csrfMiddleware, i18nMiddleware],
	functionMiddleware: [errorMiddleware],
}));
