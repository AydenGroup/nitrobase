import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Center,
	type MantineColorScheme,
	SegmentedControl,
	Tooltip,
	useComputedColorScheme,
	useMantineColorScheme,
} from "@mantine/core";
import { useMounted } from "@mantine/hooks";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";

/** Toggles the Mantine color scheme between light and dark (persisted by Mantine). */
export const ThemeSwitcher = () => {
	const { i18n } = useLingui();
	const { setColorScheme } = useMantineColorScheme();
	// The real scheme is only known in the browser: render the moon icon on
	// the server and first paint, then switch after mount (no hydration
	// mismatch).
	const computedColorScheme = useComputedColorScheme("dark", {
		getInitialValueInEffect: true,
	});
	const mounted = useMounted();

	const toggleColorScheme = () => {
		setColorScheme(computedColorScheme === "dark" ? "light" : "dark");
	};

	return (
		<ActionIcon
			onClick={toggleColorScheme}
			variant="subtle"
			color="gray"
			aria-label={
				mounted && computedColorScheme === "dark"
					? i18n._("Switch to light theme")
					: i18n._("Switch to dark theme")
			}
			radius="100%"
		>
			{mounted && computedColorScheme === "dark" ? (
				<SunIcon size={22} strokeWidth={1} aria-hidden />
			) : (
				<MoonIcon size={22} strokeWidth={1} aria-hidden />
			)}
		</ActionIcon>
	);
};

/** Light / dark / system choice (persisted by Mantine), icons only. */
export const ThemeSchemeControl: React.FC = () => {
	const { i18n } = useLingui();
	const { colorScheme, setColorScheme } = useMantineColorScheme();
	const mounted = useMounted();
	const options = [
		{ value: "light", label: i18n._("Light"), icon: SunIcon },
		{ value: "dark", label: i18n._("Dark"), icon: MoonIcon },
		{ value: "auto", label: i18n._("System"), icon: MonitorIcon },
	] as const;
	return (
		<SegmentedControl
			size="xs"
			radius="md"
			aria-label={i18n._("Theme")}
			// The stored scheme is only known in the browser.
			value={mounted ? colorScheme : "auto"}
			onChange={(value) => setColorScheme(value as MantineColorScheme)}
			data={options.map(({ value, label, icon: Icon }) => ({
				value,
				label: (
					<Tooltip label={label} withArrow>
						<Center h={18} aria-label={label}>
							<Icon size={14} aria-hidden />
						</Center>
					</Tooltip>
				),
			}))}
		/>
	);
};
