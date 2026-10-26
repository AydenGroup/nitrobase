import { useLingui } from "@lingui/react";
import { useMounted } from "@mantine/hooks";
import { formatDate } from "#/libs/intl.ts";

/**
 * A date in the viewer's locale and time zone. Formatted after hydration:
 * the server's time zone (and ICU data) can differ from the browser's, so
 * formatting during SSR would not match the client render.
 */
export const LocalDate: React.FC<{
	value: Date | string | number | null | undefined;
	options?: Intl.DateTimeFormatOptions;
	fallback?: string;
}> = ({
	value,
	options = { dateStyle: "medium", timeStyle: "short" },
	fallback = "—",
}) => {
	const { i18n } = useLingui();
	const mounted = useMounted();
	if (value === null || value === undefined) return fallback;
	const date = value instanceof Date ? value : new Date(value);
	return (
		<time dateTime={date.toISOString()} suppressHydrationWarning>
			{mounted ? formatDate(i18n.locale, date, options) : ""}
		</time>
	);
};
