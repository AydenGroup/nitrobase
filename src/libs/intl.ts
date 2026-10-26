/**
 * Locale-aware formatting (the i18n rulebook, Rule 5): thin wrappers over
 * `Intl.NumberFormat` / `Intl.DateTimeFormat` with cached formatters. Always
 * pass the active locale (`i18n.locale`); never call Lingui's deprecated
 * `i18n.number` / `i18n.date`, and never hand-build number strings.
 * Missing values (null/undefined) render as an em dash.
 */

type Maybe<T> = T | null | undefined;

export const EMPTY_VALUE = "—";

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

function numberFormat(
	locale: string,
	options: Intl.NumberFormatOptions = {},
): Intl.NumberFormat {
	const key = `${locale}|${JSON.stringify(options)}`;
	let format = numberFormats.get(key);
	if (!format) {
		format = new Intl.NumberFormat(locale, options);
		numberFormats.set(key, format);
	}
	return format;
}

function dateFormat(
	locale: string,
	options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
	const key = `${locale}|${JSON.stringify(options)}`;
	let format = dateFormats.get(key);
	if (!format) {
		format = new Intl.DateTimeFormat(locale, options);
		dateFormats.set(key, format);
	}
	return format;
}

export function formatNumber(
	locale: string,
	value: Maybe<number>,
	options?: Intl.NumberFormatOptions,
): string {
	if (value === null || value === undefined) return EMPTY_VALUE;
	return numberFormat(locale, options).format(value);
}

/**
 * Percent from a ratio (0.024 → "2.4%"), like `Intl` percent style. Default:
 * one decimal below 10%, none above.
 */
export function formatPercent(
	locale: string,
	ratio: Maybe<number>,
	options?: Intl.NumberFormatOptions,
): string {
	if (ratio === null || ratio === undefined) return EMPTY_VALUE;
	const digits = Math.abs(ratio) < 0.1 ? 1 : 0;
	return numberFormat(locale, {
		style: "percent",
		maximumFractionDigits: digits,
		...options,
	}).format(ratio);
}

/** Percent from a 0–100 value (metrics report points, not ratios). */
export function formatPercentPoints(
	locale: string,
	points: Maybe<number>,
	options?: Intl.NumberFormatOptions,
): string {
	if (points === null || points === undefined) return EMPTY_VALUE;
	return formatPercent(locale, points / 100, options);
}

export function formatDate(
	locale: string,
	value: Maybe<Date | string | number>,
	options: Intl.DateTimeFormatOptions = {
		dateStyle: "medium",
		timeStyle: "short",
	},
): string {
	if (value === null || value === undefined) return EMPTY_VALUE;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return EMPTY_VALUE;
	return dateFormat(locale, options).format(date);
}

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];

/** Byte size in 1024 steps with a localized unit ("1.5 MB", "1,5 MB"). */
export function formatBytes(locale: string, bytes: Maybe<number>): string {
	if (bytes === null || bytes === undefined) return EMPTY_VALUE;
	let value = bytes;
	let unit = 0;
	while (Math.abs(value) >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	return numberFormat(locale, {
		style: "unit",
		unit: BYTE_UNITS[unit],
		unitDisplay: "short",
		maximumFractionDigits: unit === 0 ? 0 : 1,
	}).format(value);
}

/** Transfer rate ("1.2 MB/s"). */
export function formatRate(
	locale: string,
	bytesPerSecond: Maybe<number>,
): string {
	if (bytesPerSecond === null || bytesPerSecond === undefined) {
		return EMPTY_VALUE;
	}
	let value = bytesPerSecond;
	let unit = 0;
	while (Math.abs(value) >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	return numberFormat(locale, {
		style: "unit",
		unit: `${BYTE_UNITS[unit]}-per-second`,
		unitDisplay: "short",
		maximumFractionDigits: unit === 0 ? 0 : 1,
	}).format(value);
}

function unitPart(locale: string, value: number, unit: string): string {
	return numberFormat(locale, {
		style: "unit",
		unit,
		unitDisplay: "narrow",
	}).format(value);
}

/** Compact duration from milliseconds ("120ms", "1m 5s", "2h 3m"). */
export function formatDuration(locale: string, ms: Maybe<number>): string {
	if (ms === null || ms === undefined) return EMPTY_VALUE;
	if (ms < 1000) return unitPart(locale, Math.round(ms), "millisecond");
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return unitPart(locale, seconds, "second");
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${unitPart(locale, minutes, "minute")} ${unitPart(locale, seconds % 60, "second")}`;
	}
	return `${unitPart(locale, Math.floor(minutes / 60), "hour")} ${unitPart(locale, minutes % 60, "minute")}`;
}

/** Long uptime from seconds ("12d 4h", else like `formatDuration`). */
export function formatUptime(locale: string, seconds: Maybe<number>): string {
	if (seconds === null || seconds === undefined) return EMPTY_VALUE;
	const days = Math.floor(seconds / 86_400);
	if (days > 0) {
		return `${unitPart(locale, days, "day")} ${unitPart(locale, Math.floor((seconds % 86_400) / 3600), "hour")}`;
	}
	return formatDuration(locale, seconds * 1000);
}

const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();

/** "2 minutes ago" / "in 3 hours" (auto unit; `now` for tests). */
export function formatRelativeTime(
	locale: string,
	value: Maybe<Date | string | number>,
	now: number = Date.now(),
): string {
	if (value === null || value === undefined) return EMPTY_VALUE;
	const time = new Date(value).getTime();
	if (Number.isNaN(time)) return EMPTY_VALUE;
	let format = relativeFormats.get(locale);
	if (!format) {
		format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
		relativeFormats.set(locale, format);
	}
	const seconds = Math.round((time - now) / 1000);
	const units: [Intl.RelativeTimeFormatUnit, number][] = [
		["year", 31_536_000],
		["month", 2_592_000],
		["week", 604_800],
		["day", 86_400],
		["hour", 3600],
		["minute", 60],
	];
	for (const [unit, size] of units) {
		if (Math.abs(seconds) >= size) {
			return format.format(Math.round(seconds / size), unit);
		}
	}
	return format.format(seconds, "second");
}

/** A UTC offset in minutes as "UTC+07:00". */
export function formatUtcOffset(minutes: number): string {
	const sign = minutes >= 0 ? "+" : "-";
	const abs = Math.abs(minutes);
	const hh = String(Math.floor(abs / 60)).padStart(2, "0");
	const mm = String(abs % 60).padStart(2, "0");
	return `UTC${sign}${hh}:${mm}`;
}

const languageNames = new Map<string, Intl.DisplayNames>();

/**
 * Name of the language `code` written in `locale`, capitalized as a menu
 * label: `formatLanguageName(code, code)` is the endonym the language menu
 * shows. Falls back to the code when the runtime has no name for it.
 */
export function formatLanguageName(locale: string, code: string): string {
	let names = languageNames.get(locale);
	if (!names) {
		names = new Intl.DisplayNames([locale], {
			type: "language",
			fallback: "code",
		});
		languageNames.set(locale, names);
	}
	const [first = "", ...rest] = Array.from(names.of(code) ?? code);
	return first.toLocaleUpperCase(locale) + rest.join("");
}

const listFormats = new Map<string, Intl.ListFormat>();

/** Locale-aware list ("a, b and c"; `unit` style: "a, b, c"). */
export function formatList(
	locale: string,
	items: readonly string[],
	type: "conjunction" | "disjunction" | "unit" = "conjunction",
): string {
	if (items.length === 0) return EMPTY_VALUE;
	const key = `${locale}|${type}`;
	let format = listFormats.get(key);
	if (!format) {
		format = new Intl.ListFormat(locale, {
			type,
			style: type === "unit" ? "short" : "long",
		});
		listFormats.set(key, format);
	}
	return format.format(items);
}
