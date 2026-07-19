import { createCsrfMiddleware, createStart } from "@tanstack/react-start";
import { i18nMiddleware } from "./i18n/i18nMiddleware";

const csrfMiddleware = createCsrfMiddleware({
	filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
	requestMiddleware: [csrfMiddleware, i18nMiddleware],
}));
