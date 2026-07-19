import { setupI18n } from "@lingui/core";
import { createMiddleware } from "@tanstack/react-start";
import { dynamicActivate } from "./i18n.functions";
import { getLocaleFromRequest } from "./i18n.server";

export const i18nMiddleware = createMiddleware({ type: "request" }).server(
	async ({ request, next }) => {
		const { locale, headers } = getLocaleFromRequest(request);

		const i18n = setupI18n();
		await dynamicActivate(i18n, locale);

		const result = await next({
			context: {
				locale,
				i18n,
			},
		});

		if (headers) {
			headers.forEach(({ key, value }) => {
				result.response.headers.append(key, value);
			});
		}

		return result;
	},
);
