import { MantineProvider, type MantineProviderProps } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import type React from "react";
import type { PropsWithChildren } from "react";
import { Notifications } from "#/components/ui/Notifications.tsx";
import { NProgress } from "#/components/ui/NProgress.tsx";
import { mantineTheme } from ".";
import { mantineCssVariableResolver } from "./cssVariableResolver";

/**
 * Mantine provider with the app theme, plus the app-wide modal manager,
 * route progress bar and notification container. Props are forwarded to
 * MantineProvider (e.g. `defaultColorScheme` from router context).
 */
export const ThemeProvider: React.FC<
	PropsWithChildren<MantineProviderProps>
> = ({ children, ...mantineProps }) => {
	return (
		<MantineProvider
			theme={mantineTheme}
			cssVariablesResolver={mantineCssVariableResolver}
			{...mantineProps}
		>
			<ModalsProvider>{children}</ModalsProvider>
			<NProgress />
			<Notifications position="top-center" />
		</MantineProvider>
	);
};
