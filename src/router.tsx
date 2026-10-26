import { QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { routerWithI18n, setupI18n } from "#/libs/i18n";
import { routeTree } from "./routeTree.gen";

/**
 * Router factory used by TanStack Start (per SSR request and once on the
 * client). Each call gets its own QueryClient and Lingui instance so
 * requests never share cache or locale state.
 */
export function getRouter() {
	const queryClient = new QueryClient();
	const i18n = setupI18n();

	const createRouter = createTanStackRouter({
		routeTree,
		context: { queryClient, i18n, themeColorScheme: "dark" },
		scrollRestoration: true,
		// Preload on hover/focus; staleTime 0 leaves caching to React Query
		// rather than the router's own loader cache.
		defaultPreload: "intent",
		defaultPreloadStaleTime: 0,
	});

	// Adds the Lingui I18nProvider and hydrates the server-chosen locale.
	const router = routerWithI18n(createRouter, i18n);
	// Dehydrates queries fetched during SSR into the HTML and hydrates them
	// on the client, so loaders don't refetch after hydration.
	setupRouterSsrQueryIntegration({ router, queryClient });

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
