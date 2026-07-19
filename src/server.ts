import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { createCookieHeader } from "./i18n/i18n.functions";
import { handleLocaleMiddleware } from "./i18n/localeMiddleware.server";

export default createServerEntry({
	async fetch(request) {
		const { redirect, setCookie } = handleLocaleMiddleware(request);
		if (redirect) {
			return redirect;
		}

		const response = await handler.fetch(request);

		if (setCookie) {
			const cookieValue = createCookieHeader(setCookie.name, setCookie.value);
			response.headers.append("Set-Cookie", cookieValue);
		}

		return response;
	},
});
