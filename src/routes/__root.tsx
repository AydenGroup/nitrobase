import type { I18n } from "@lingui/core";
import {
	ColorSchemeScript,
	type MantineColorScheme,
	mantineHtmlProps,
} from "@mantine/core";
import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { DefaultCatchBoundary } from "#/components/ui/DefaultCatchBoundary.tsx";
import { NotFoundState } from "#/components/ui/NotFoundState.tsx";
import { APP_NAME } from "#/config/shared.ts";
import {
	initialUserQueryOptions,
	userQueryOptions,
} from "#/features/auth/auth.query.ts";
import { localeDirection } from "#/libs/i18n.ts";
import { ACCENT_BOOT_SCRIPT, ACCENT_CSS } from "#/theme/accent-css.ts";
import { ThemeProvider } from "#/theme/ThemeProvider.tsx";
import { seo } from "#/utils/seo.ts";
import appCss from "../theme/styles.css?url";

/** Context provided by `getRouter()` and available to every route. */
interface MyRouterContext {
	i18n: I18n;
	themeColorScheme: MantineColorScheme;
	queryClient: QueryClient;
}

/**
 * Root route: resolves the session user and whether first-run setup is done,
 * and renders the HTML document shell.
 */
export const Route = createRootRouteWithContext<MyRouterContext>()({
	// Runs on every navigation. `staleTime: "static"` makes these cache hits
	// after the first fetch; auth flows invalidate them explicitly. The
	// returned `user` and `isSetupComplete` are merged into child contexts.
	beforeLoad: async ({ context }) => {
		const user = await context.queryClient.query({
			...userQueryOptions,
			staleTime: "static",
		});

		const isSetupComplete = await context.queryClient.query({
			...initialUserQueryOptions,
			staleTime: "static",
		});
		return { user, isSetupComplete };
	},
	notFoundComponent: () => <NotFoundState />,
	errorComponent: DefaultCatchBoundary,
	// Title/description are localized here (not in `head`) because `head`
	// has no access to router context.
	loader: async ({ context }) => {
		const { i18n } = context;
		return {
			title: i18n._("{appName} - Self-hosted VPS PaaS & BaaS Deployer", {
				appName: APP_NAME,
			}),
			description: i18n._(
				"{appName} is a self-hosted platform to connect VPS via SSH, bootstrap Docker & Traefik, and deploy BaaS like Supabase.",
				{ appName: APP_NAME },
			),
		};
	},
	head: ({ loaderData }) => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			...seo({
				title: loaderData?.title || APP_NAME,
				description: loaderData?.description,
			}),
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
			{ rel: "icon", href: "/favicon.ico", sizes: "32x32" },
			{ rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
			{ rel: "manifest", href: "/manifest.json" },
		],
	}),
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	const { i18n, themeColorScheme } = Route.useRouteContext();
	return (
		<html
			lang={i18n.locale}
			dir={localeDirection(i18n.locale)}
			{...mantineHtmlProps}
		>
			<head>
				<HeadContent />
				{/* Applies the stored color scheme before paint (no theme flash). */}
				<ColorSchemeScript defaultColorScheme={themeColorScheme} />
				{/* Accent color: CSS variables per accent, and the stored choice applied before paint. */}
				<style
					id="accent-css"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: build-time constant from the accent registry, no user input
					dangerouslySetInnerHTML={{ __html: ACCENT_CSS }}
				/>
				<script
					// biome-ignore lint/security/noDangerouslySetInnerHtml: build-time constant from the accent registry, no user input
					dangerouslySetInnerHTML={{ __html: ACCENT_BOOT_SCRIPT }}
				/>
			</head>
			<body>
				<ThemeProvider defaultColorScheme={themeColorScheme}>
					{children}
				</ThemeProvider>

				{/* Removed from production builds by the devtools Vite plugin. */}
				<TanStackDevtools
					config={{
						position: "bottom-right",
					}}
					plugins={[
						{
							name: "Tanstack Router",
							render: <TanStackRouterDevtoolsPanel />,
						},
						{
							name: "Tanstack Query",
							render: <ReactQueryDevtoolsPanel />,
						},
					]}
				/>
				<Scripts />
			</body>
		</html>
	);
}
