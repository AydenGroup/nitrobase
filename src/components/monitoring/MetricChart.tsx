import { useLingui } from "@lingui/react";
import { AreaChart, LineChart } from "@mantine/charts";
import { Center, Stack, Text } from "@mantine/core";
import { formatDate } from "#/libs/intl.ts";
import { chartOtherColor, chartSeriesColors } from "#/theme/tokens.ts";

export interface ChartSeries {
	name: string;
	label: string;
}

export interface ChartReference {
	y: number;
	label: string;
}

/**
 * Time series chart (one y axis, x = epoch ms). Series get the fixed
 * categorical colors in order; a series named `other` is the neutral color.
 */
export const MetricChart: React.FC<{
	title: string;
	data: Record<string, number | null>[];
	series: ChartSeries[];
	format: (value: number) => string;
	/** Range in seconds: picks the time label format. */
	rangeSeconds: number;
	yMax?: number;
	reference?: ChartReference;
	area?: boolean;
	h?: number;
}> = ({
	title,
	data,
	series,
	format,
	rangeSeconds,
	yMax,
	reference,
	area = false,
	h = 180,
}) => {
	const { i18n } = useLingui();
	const timeLabel = (value: number) =>
		formatDate(
			i18n.locale,
			value,
			rangeSeconds > 86_400
				? { month: "short", day: "numeric", hour: "2-digit" }
				: { hour: "2-digit", minute: "2-digit" },
		);
	const colored = series.map((item, index) => ({
		name: item.name,
		label: item.label,
		color:
			item.name === "other"
				? chartOtherColor
				: chartSeriesColors[index % chartSeriesColors.length],
	}));
	const Chart = area ? AreaChart : LineChart;
	return (
		<Stack gap={4}>
			<Text size="sm" fw={600} c="dimmed">
				{title}
			</Text>
			{data.length === 0 ? (
				<Center h={h}>
					<Text size="sm" c="dimmed">
						{i18n._("No data for this range yet.")}
					</Text>
				</Center>
			) : (
				<Chart
					h={h}
					data={data}
					dataKey="t"
					series={colored}
					curveType="linear"
					withDots={false}
					strokeWidth={1.5}
					withLegend={series.length > 1}
					legendProps={{ verticalAlign: "bottom", height: 32 }}
					valueFormatter={format}
					connectNulls={false}
					gridAxis="x"
					strokeDasharray="none"
					tickLine="none"
					gridColor="var(--chart-grid)"
					textColor="var(--chart-axis)"
					xAxisProps={{
						type: "number",
						scale: "time",
						domain: ["dataMin", "dataMax"],
						tickFormatter: timeLabel,
						minTickGap: 40,
					}}
					yAxisProps={{
						domain: [0, yMax ?? "auto"],
						tickFormatter: format,
						width: 70,
					}}
					tooltipProps={{
						labelFormatter: (value) => formatDate(i18n.locale, Number(value)),
					}}
					referenceLines={
						reference
							? [
									{
										y: reference.y,
										label: reference.label,
										color: "var(--mantine-color-red-6)",
										strokeDasharray: "4 4",
										opacity: 0.8,
									},
								]
							: undefined
					}
				/>
			)}
		</Stack>
	);
};

/**
 * Pivot long rows (`t`, key, value) into chart rows with one column per
 * key. Column names are generated (`s0`, `s1`...: recharts reads dots in a
 * data key as a path); labels keep the real key. Keys beyond
 * `maxSeries - 1` (by total value) are summed into `other`.
 */
export function pivotSeries<T>(
	rows: T[],
	options: {
		time: (row: T) => number;
		key: (row: T) => string;
		value: (row: T) => number | null;
		otherLabel: string;
		maxSeries?: number;
	},
): { data: Record<string, number | null>[]; series: ChartSeries[] } {
	const max = options.maxSeries ?? chartSeriesColors.length;
	const totals = new Map<string, number>();
	for (const row of rows) {
		const key = options.key(row);
		totals.set(key, (totals.get(key) ?? 0) + (options.value(row) ?? 0));
	}
	const ranked = [...totals.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([key]) => key);
	const overflow = ranked.length > max;
	const keys = (overflow ? ranked.slice(0, max - 1) : ranked).sort();
	const column = new Map(keys.map((key, index) => [key, `s${index}`]));
	const byTime = new Map<number, Record<string, number | null>>();
	for (const row of rows) {
		const t = options.time(row);
		const point = byTime.get(t) ?? { t };
		const name = column.get(options.key(row)) ?? "other";
		const value = options.value(row);
		if (value !== null) {
			point[name] = name === "other" ? (point[name] ?? 0) + value : value;
		}
		byTime.set(t, point);
	}
	return {
		data: [...byTime.values()].sort((a, b) => Number(a.t) - Number(b.t)),
		series: [
			...keys.map((key, index) => ({ name: `s${index}`, label: key })),
			...(overflow ? [{ name: "other", label: options.otherLabel }] : []),
		],
	};
}
