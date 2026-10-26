import type {
	MantineColorsTuple,
	MantineThemeOverride,
	VariantColorsResolver,
} from "@mantine/core";
import {
	Accordion,
	ActionIcon,
	AppShell,
	Badge,
	Button,
	Card,
	Chip,
	Container,
	createTheme,
	Divider,
	Drawer,
	defaultVariantColorsResolver,
	Menu,
	Modal,
	MultiSelect,
	NavLink,
	NumberInput,
	Paper,
	PasswordInput,
	rem,
	SegmentedControl,
	Select,
	Stepper,
	Table,
	Tabs,
	Textarea,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { statusColors } from "./status-colors";
import { darkScale, surfaces } from "./surfaces";
import { ACCENT, FONT_MONO, FONT_SANS } from "./tokens";

/**
 * Variant colors from the surface (`--sb-*`) and accent (`--accent-*`) tokens,
 * which already switch per color scheme: the accent fills `brand` buttons and
 * badges, every other variant stays neutral.
 */
const customVariantColorResolver: VariantColorsResolver = (input) => {
	const defaultResolved = defaultVariantColorsResolver(input);

	if (input.color === "brand" || input.color === undefined) {
		if (input.variant === "filled") {
			return {
				...defaultResolved,
				background: "var(--accent-fill)",
				hover: "var(--accent-fill-hover)",
				color: "var(--accent-on-fill)",
				border: "1px solid var(--accent-fill)",
			};
		}

		if (input.variant === "light") {
			return {
				...defaultResolved,
				background: "var(--sb-control)",
				hover: "var(--sb-hover)",
				color: "var(--sb-text-1)",
				border: "1px solid var(--sb-border-strong)",
			};
		}

		if (input.variant === "outline") {
			return {
				...defaultResolved,
				background: "transparent",
				hover: "var(--sb-hover)",
				color: "var(--sb-text-1)",
				border: "1px solid var(--sb-border-strong)",
			};
		}

		if (input.variant === "subtle") {
			return {
				...defaultResolved,
				background: "transparent",
				hover: "var(--sb-hover)",
				color: "var(--sb-text-1)",
				border: "1px solid transparent",
			};
		}
	}

	return defaultResolved;
};

/**
 * Neutral scale for the `brand` primary color. The accent itself never comes
 * from this tuple: filled/focus/link colors read `--accent-*` (see
 * cssVariableResolver.ts), so a tuple step is only a neutral fallback.
 */
const brand: MantineColorsTuple = darkScale(surfaces.dark);

const dark: MantineColorsTuple = darkScale(surfaces.dark);

/**
 * Named Container widths, including extra `xxs`/`xxl` steps. Applied by the
 * Container `vars` resolver below; any other size value is passed to `rem()`.
 */
const CONTAINER_SIZES: Record<string, string> = {
	xxs: rem("200px"),
	xs: rem("300px"),
	sm: rem("400px"),
	md: rem("500px"),
	lg: rem("600px"),
	xl: rem("1400px"),
	xxl: rem("1600px"),
};

const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Transition of a control: color-ish properties only, no layout shifts. */
const controlTransition = (ms: number): string =>
	`border-color ${ms}ms ${EASE}, background-color ${ms}ms ${EASE}, box-shadow ${ms}ms ${EASE}`;

/**
 * App-wide Mantine theme:
 * - Flat: pure surface layering and 1px hairlines; floating surfaces get a soft
 *   shadow from CSS (`--sb-shadow-pop`), never from Mantine shadows.
 * - Compact: 14px text, 13px controls, 4px-based spacing.
 * - Smooth: radii 4/6/8/10/14, spring-out easing, tactile button feedback.
 */
export const mantineTheme: MantineThemeOverride = createTheme({
	colors: {
		brand,
		dark,
		...statusColors,
	},
	primaryColor: ACCENT,
	primaryShade: { light: 8, dark: 6 },
	autoContrast: true,
	variantColorResolver: customVariantColorResolver,
	defaultRadius: "md",
	radius: {
		xs: rem("4px"),
		sm: rem("6px"),
		md: rem("8px"),
		lg: rem("10px"),
		xl: rem("14px"),
	},
	shadows: {
		xs: "none",
		sm: "none",
		md: "none",
		lg: "none",
		xl: "none",
	},
	cursorType: "pointer",
	focusRing: "auto",
	headings: {
		fontFamily: FONT_SANS,
		fontWeight: "600",
		sizes: {
			h1: { fontSize: rem("20px"), lineHeight: "1.4" },
			h2: { fontSize: rem("20px"), lineHeight: "1.4" },
			h3: { fontSize: rem("16px"), lineHeight: "1.4" },
			h4: { fontSize: rem("14px"), lineHeight: "1.45" },
			h5: { fontSize: rem("14px"), lineHeight: "1.45" },
			h6: { fontSize: rem("13px"), lineHeight: "1.45" },
		},
	},
	fontFamily: FONT_SANS,
	fontFamilyMonospace: FONT_MONO,
	fontWeights: {
		medium: "500",
	},
	fontSizes: {
		xs: rem("12px"),
		sm: rem("13px"),
		md: rem("14px"),
		lg: rem("16px"),
		xl: rem("18px"),
		"2xl": rem("20px"),
		"3xl": rem("24px"),
		"4xl": rem("30px"),
		"5xl": rem("36px"),
	},
	spacing: {
		"3xs": rem("4px"),
		"2xs": rem("6px"),
		xs: rem("8px"),
		sm: rem("12px"),
		md: rem("16px"),
		lg: rem("20px"),
		xl: rem("24px"),
		"2xl": rem("32px"),
		"3xl": rem("40px"),
	},
	components: {
		Container: Container.extend({
			vars: (_, { size, fluid }) => ({
				root: {
					"--container-size": fluid
						? "100%"
						: size !== undefined && size in CONTAINER_SIZES
							? CONTAINER_SIZES[size]
							: rem(size),
				},
			}),
		}),

		AppShell: AppShell.extend({
			styles() {
				return {
					// The sidebar sinks into the canvas: no surface of its own, no divider.
					navbar: {
						background: "var(--sb-canvas)",
						borderInlineEnd: "none",
					},
					// Mobile top bar only; on desktop the panel carries its own bar.
					header: {
						background: "var(--sb-canvas)",
						borderBottom: "1px solid var(--sb-border)",
					},
				};
			},
		}),

		Paper: Paper.extend({
			defaultProps: {
				shadow: "none",
				radius: "lg",
				withBorder: true,
				bg: "var(--sb-card)",
			},
		}),

		Card: Card.extend({
			styles: {
				root: {
					"--paper-border-color": "var(--sb-border)",
					transition: `border-color 160ms ${EASE}, background-color 160ms ${EASE}`,
				},
			},
			defaultProps: {
				radius: "lg",
				bg: "var(--sb-card)",
				withBorder: true,
			},
		}),

		Button: Button.extend({
			defaultProps: { radius: "md" },
			styles: {
				root: {
					fontWeight: 500,
					transition: `transform 140ms ${EASE}, ${controlTransition(140)}, color 140ms ${EASE}`,
				},
			},
		}),

		Chip: Chip.extend({
			defaultProps: { radius: "xl" },
			styles: {
				label: {
					fontWeight: 500,
					transition: `${controlTransition(140)}, color 140ms ${EASE}`,
				},
			},
		}),

		ActionIcon: ActionIcon.extend({
			defaultProps: { radius: "md" },
			styles: {
				root: {
					transition: `transform 140ms ${EASE}, ${controlTransition(140)}, color 140ms ${EASE}`,
				},
			},
		}),

		TextInput: TextInput.extend({
			defaultProps: { radius: "md" },
			styles: { input: { transition: controlTransition(150) } },
		}),

		PasswordInput: PasswordInput.extend({
			defaultProps: { radius: "md" },
			styles: { innerInput: { transition: controlTransition(150) } },
		}),

		Select: Select.extend({
			defaultProps: {
				radius: "md",
				checkIconPosition: "right",
			},
			styles: { input: { transition: controlTransition(150) } },
		}),

		MultiSelect: MultiSelect.extend({
			defaultProps: { radius: "md" },
			styles: { input: { transition: controlTransition(150) } },
		}),

		NumberInput: NumberInput.extend({
			defaultProps: { radius: "md" },
			styles: { input: { transition: controlTransition(150) } },
		}),

		Textarea: Textarea.extend({
			defaultProps: { radius: "md" },
			styles: { input: { transition: controlTransition(150) } },
		}),

		// Status badges: mono, uppercase, pill (hairline tint comes from styles.css).
		Badge: Badge.extend({
			defaultProps: { radius: "xl" },
			styles: {
				root: {
					fontFamily: FONT_MONO,
					textTransform: "uppercase",
					fontSize: rem("10px"),
					letterSpacing: "0.04em",
					fontWeight: 500,
				},
			},
		}),

		Menu: Menu.extend({
			defaultProps: {
				radius: "lg",
				shadow: "none",
			},
			styles() {
				return {
					dropdown: {
						background: "var(--sb-card)",
						border: "1px solid var(--sb-border-strong)",
					},
					item: {
						borderRadius: "var(--mantine-radius-sm)",
						transition: `background-color 120ms ${EASE}, color 120ms ${EASE}`,
					},
				};
			},
		}),

		Modal: Modal.extend({
			defaultProps: {
				radius: "xl",
				shadow: "none",
				overlayProps: {
					backgroundOpacity: 0.5,
					blur: 4,
				},
			},
			styles: {
				content: {
					border: "1px solid var(--sb-border-strong)",
					background: "var(--sb-card)",
				},
				header: { background: "var(--sb-card)" },
			},
		}),

		Drawer: Drawer.extend({
			defaultProps: {
				offset: 5,
				radius: "lg",
				shadow: "none",
				overlayProps: {
					backgroundOpacity: 0.5,
					blur: 4,
				},
			},
			styles: {
				content: {
					border: "1px solid var(--sb-border-strong)",
					background: "var(--sb-card)",
				},
				header: { background: "var(--sb-card)" },
			},
		}),

		Table: Table.extend({
			defaultProps: {
				borderColor: "var(--mantine-color-default-border)",
			},
			vars: () => ({
				table: {
					"--table-border-color": "var(--mantine-color-default-border)",
				},
			}),
			styles: {
				tr: { transition: `background-color 120ms ${EASE}` },
			},
		}),

		Tabs: Tabs.extend({
			styles: {
				tab: {
					fontWeight: 500,
					transition: `color 140ms ${EASE}, ${controlTransition(140)}`,
				},
			},
		}),

		NavLink: NavLink.extend({
			styles: {
				root: {
					borderRadius: "var(--mantine-radius-md)",
					fontSize: "var(--mantine-font-size-sm)",
					minHeight: rem("30px"),
					transition: `background-color 140ms ${EASE}, color 140ms ${EASE}`,
				},
			},
		}),

		Tooltip: Tooltip.extend({
			defaultProps: {
				radius: "sm",
				transitionProps: {
					transition: "fade",
					duration: 120,
				},
			},
		}),

		SegmentedControl: SegmentedControl.extend({
			defaultProps: { radius: "md" },
			styles: {
				root: {
					border: "1px solid var(--sb-border)",
					background: "var(--sb-input)",
				},
				indicator: {
					boxShadow: "none",
					border: "1px solid var(--sb-border-strong)",
					background: "var(--sb-active)",
					transition: `transform 160ms ${EASE}, width 160ms ${EASE}`,
				},
			},
		}),

		Stepper: Stepper.extend({
			styles: {
				stepIcon: { transition: `all 140ms ${EASE}` },
			},
		}),

		Divider: Divider.extend({
			defaultProps: {
				color: "var(--mantine-color-default-border)",
			},
		}),

		Accordion: Accordion.extend({
			defaultProps: {
				radius: "lg",
			},
		}),
	},
});
