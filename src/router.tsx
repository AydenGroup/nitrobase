import { setupI18n } from "@lingui/core";
import { QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { getGlobalStartContext } from "@tanstack/react-start";
import { routerWithI18n } from "./i18n/router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
	const queryClient = new QueryClient();
	const context = getGlobalStartContext();
	const i18n = context?.i18n ?? setupI18n();

	const createRouter = createTanStackRouter({
		routeTree,
		context: { queryClient, i18n, themeColorScheme: "auto" },
		scrollRestoration: true,
		defaultPreload: "intent",
		defaultPreloadStaleTime: 0,
	});

	const router = routerWithI18n(createRouter, i18n);
	setupRouterSsrQueryIntegration({ router, queryClient });

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
