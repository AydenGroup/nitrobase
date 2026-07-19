import { MantineProvider, type MantineProviderProps } from "@mantine/core";
import type React from "react";
import type { PropsWithChildren } from "react";
import { NProgress } from "@/components/ui/NProgress";
import { theme } from ".";

export const ThemeProvider: React.FC<
	PropsWithChildren<MantineProviderProps>
> = ({ children, ...mantineProps }) => {
	return (
		<MantineProvider theme={theme} {...mantineProps} classNamesPrefix="fe">
			{children}
			<NProgress />
		</MantineProvider>
	);
};
