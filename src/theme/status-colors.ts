import type { MantineColorsTuple } from "@mantine/core";

/**
 * Softer palettes for the status colors (success, danger, warning, info) than
 * Mantine's defaults, as 10-step tuples from lightest to darkest. Steps follow
 * Mantine's own brightness (step 6 about Tailwind 500, step 9 about 800), so code
 * that asks for e.g. `red.6` keeps the same weight. Mantine reads step 4 as text
 * on dark, 6 as the dark fill, 8 as the light fill, 1 and 9 as the light tint and
 * its text. Step 5 is the midpoint of Tailwind 400 and 500.
 */
export const statusColors: Record<
	"green" | "red" | "yellow" | "orange" | "blue",
	MantineColorsTuple
> = {
	green: [
		"#ecfdf5",
		"#d1fae5",
		"#a7f3d0",
		"#6ee7b7",
		"#34d399",
		"#22c68d",
		"#10b981",
		"#059669",
		"#047857",
		"#065f46",
	],
	red: [
		"#fef2f2",
		"#fee2e2",
		"#fecaca",
		"#fca5a5",
		"#f87171",
		"#f45a5a",
		"#ef4444",
		"#dc2626",
		"#b91c1c",
		"#991b1b",
	],
	yellow: [
		"#fffbeb",
		"#fef3c7",
		"#fde68a",
		"#fcd34d",
		"#fbbf24",
		"#f8ae17",
		"#f59e0b",
		"#d97706",
		"#b45309",
		"#92400e",
	],
	orange: [
		"#fff7ed",
		"#ffedd5",
		"#fed7aa",
		"#fdba74",
		"#fb923c",
		"#fa8229",
		"#f97316",
		"#ea580c",
		"#c2410c",
		"#9a3412",
	],
	blue: [
		"#eff6ff",
		"#dbeafe",
		"#bfdbfe",
		"#93c5fd",
		"#60a5fa",
		"#4d93f8",
		"#3b82f6",
		"#2563eb",
		"#1d4ed8",
		"#1e40af",
	],
};
