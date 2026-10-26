/** Linear-light value of one sRGB channel (0-255), per WCAG 2.x. */
const channel = (value: number): number => {
	const c = value / 255;
	return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** Relative luminance (0-1) of a `#rrggbb` color. */
export const luminance = (hex: string): number => {
	const value = Number.parseInt(hex.slice(1), 16);
	const r = channel((value >> 16) & 255);
	const g = channel((value >> 8) & 255);
	const b = channel(value & 255);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio (1-21) between two `#rrggbb` colors, order-independent. */
export const contrastRatio = (
	foreground: string,
	background: string,
): number => {
	const a = luminance(foreground);
	const b = luminance(background);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
