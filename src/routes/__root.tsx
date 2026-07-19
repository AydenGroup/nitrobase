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
import { ThemeProvider } from "#/theme/ThemeProvider.tsx";
import { seo } from "#/utils/seo.ts";
import appCss from "../theme/styles.css?url";

interface MyRouterContext {
	i18n: I18n;
	themeColorScheme: MantineColorScheme;
	queryClient: QueryClient;
}
export const Route = createRootRouteWithContext<MyRouterContext>()({
	loader: async ({ context }) => {
		const { i18n } = context;
		return {
			title: i18n._(
				"SassBase - AI headless database and AI-powered SaaS platform.",
			),
			description: i18n._(
				"SassBase is a PaSS platform that provides a headless database and AI-powered SaaS solutions for developers and businesses.",
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
				title: loaderData?.title || "SassBase",
				description: loaderData?.description,
			}),
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
		],
	}),
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	const { i18n, themeColorScheme } = Route.useRouteContext();
	return (
		<html lang={i18n.locale} {...mantineHtmlProps}>
			<head>
				<HeadContent />
				<ColorSchemeScript defaultColorScheme={themeColorScheme} />
			</head>
			<body>
				<ThemeProvider defaultColorScheme={themeColorScheme}>
					{children}
				</ThemeProvider>

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
