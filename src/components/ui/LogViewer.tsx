import type { I18n } from "@lingui/core";
import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Badge,
	Box,
	Group,
	Highlight,
	SegmentedControl,
	Switch,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
import {
	ArrowDownToLine,
	Check,
	Copy,
	Download,
	Search,
	X,
} from "lucide-react";
import {
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { logEventLevel, logEventText } from "#/config/job-log-events.ts";
import { LOG_LEVEL_IDS, LOG_VIEWER, logLevels } from "#/config/log-levels.ts";
import { type LogLevel, parseLogLine } from "#/libs/job-log.ts";
import { detectLogLine } from "#/libs/log-level.ts";
import { toneColors } from "#/theme/tokens.ts";

export interface LogEntry {
	/** Stable key (sequence number or index). */
	key: string | number;
	/** `[HH:MM:SS] text` (raw output, or an event's source-language text). */
	line: string;
	/** Job log event (rendered in the reader's language); null for raw output. */
	code?: string | null;
	params?: Record<string, unknown> | null;
}

/**
 * How lines are read:
 * - `job`: `[HH:MM:SS] msg` job log lines and coded events (registry level);
 * - `raw`: container/command output, level detected per line
 *   (`#/libs/log-level.ts`), JSON logs show their message;
 * - `plain`: shown as is.
 */
export type LogFormat = "job" | "raw" | "plain";

/** Toolbar parts above the log (all opt-in). */
export interface LogToolbarOptions {
	/** Level filter with counts. */
	filter?: boolean;
	/** Text search: keeps matching lines and highlights the match. */
	search?: boolean;
	/** Switch between parsed messages and the lines as received. */
	raw?: boolean;
	/** Copy the visible lines. */
	copy?: boolean;
	/** File name (no extension) to download the visible lines as. */
	download?: string;
}

interface LogRow {
	key: string | number;
	raw: string;
	time?: string;
	timestamp?: string;
	source?: string;
	message: string;
	level: LogLevel | null;
}

type ParsedRow = Omit<LogRow, "key">;
type LevelFilter = "all" | LogLevel;

/**
 * Time, text and level of a job log entry: events are rendered from their
 * code (reader's language, registry level), raw output as is.
 */
function parseJobEntry(i18n: I18n, entry: LogEntry): ParsedRow {
	const parsed = parseLogLine(entry.line);
	const message = entry.code
		? logEventText(i18n, entry.code, entry.params)
		: null;
	return {
		raw: entry.line,
		time: parsed.time,
		message: message ?? parsed.message,
		level:
			(message !== null && entry.code ? logEventLevel(entry.code) : null) ??
			parsed.level,
	};
}

function parseEntry(
	i18n: I18n,
	format: LogFormat,
	composePrefix: boolean,
	entry: LogEntry,
): ParsedRow {
	if (format === "job") return parseJobEntry(i18n, entry);
	if (format === "raw") return detectLogLine(entry.line, { composePrefix });
	return { raw: entry.line, message: entry.line, level: null };
}

/** Text a row copies/downloads as: what the reader sees. */
function rowText(row: LogRow, format: LogFormat, raw: boolean): string {
	if (raw || format !== "job") return row.raw;
	return row.time ? `[${row.time}] ${row.message}` : row.message;
}

/**
 * Parses entries once per line: rows are cached by line (and event code)
 * so a stream appending lines re-parses only the new ones.
 */
function useLogRows(
	entries: LogEntry[],
	format: LogFormat,
	composePrefix: boolean,
): LogRow[] {
	const { i18n } = useLingui();
	const cache = useRef<{ signature: string; rows: Map<string, ParsedRow> }>({
		signature: "",
		rows: new Map(),
	});
	return useMemo(() => {
		const signature = `${i18n.locale}|${format}|${composePrefix}`;
		const previous =
			cache.current.signature === signature ? cache.current.rows : new Map();
		const next = new Map<string, ParsedRow>();
		const rows = entries.map((entry) => {
			const id = `${entry.code ?? ""}\u0000${entry.line}`;
			let parsed = next.get(id) ?? previous.get(id);
			if (!parsed) parsed = parseEntry(i18n, format, composePrefix, entry);
			next.set(id, parsed);
			return { key: entry.key, ...parsed };
		});
		cache.current = { signature, rows: next };
		return rows;
	}, [entries, format, composePrefix, i18n]);
}

const LevelBadge: React.FC<{ level: LogLevel | null }> = ({ level }) => {
	const { i18n } = useLingui();
	const width = { width: LOG_VIEWER.badgeWidth };
	if (!level) return <span className="log-badge-slot" style={width} />;
	const meta = logLevels[level];
	const Icon = meta.icon;
	return (
		<span className="log-badge-slot" style={width}>
			<Badge
				size="xs"
				variant="light"
				radius="sm"
				color={toneColors[meta.tone]}
				w={LOG_VIEWER.badgeWidth}
				leftSection={<Icon size={LOG_VIEWER.badgeIconSize} />}
			>
				{i18n._(meta.label)}
			</Badge>
		</span>
	);
};

const LogLine: React.FC<{
	row: LogRow;
	raw: boolean;
	search: string;
}> = ({ row, raw, search }) => {
	const meta = row.level ? logLevels[row.level] : null;
	const color = meta?.emphasis ? toneColors[meta.tone] : null;
	const text = raw ? row.raw : row.message;
	return (
		<div
			className="log-row"
			data-emphasis={color ? true : undefined}
			title={row.raw}
			style={
				{
					height: LOG_VIEWER.rowHeight,
					"--log-tint": color
						? `var(--mantine-color-${color}-light)`
						: undefined,
					"--log-text": color
						? `var(--mantine-color-${color}-text)`
						: undefined,
				} as React.CSSProperties
			}
		>
			{!raw && row.time && (
				<span className="log-time" title={row.timestamp}>
					{row.time}
				</span>
			)}
			<LevelBadge level={row.level} />
			{!raw && row.source && <span className="log-source">{row.source}</span>}
			{search ? (
				<Highlight
					component="span"
					className="log-message"
					highlight={search}
					inherit
				>
					{text}
				</Highlight>
			) : (
				<span className="log-message">{text}</span>
			)}
		</div>
	);
};

const LogToolbar: React.FC<{
	options: LogToolbarOptions;
	counts: Record<LogLevel, number>;
	total: number;
	level: LevelFilter;
	onLevel: (level: LevelFilter) => void;
	search: string;
	onSearch: (search: string) => void;
	raw: boolean;
	onRaw: (raw: boolean) => void;
	visibleText: () => string;
}> = ({
	options,
	counts,
	total,
	level,
	onLevel,
	search,
	onSearch,
	raw,
	onRaw,
	visibleText,
}) => {
	const { i18n } = useLingui();
	const clipboard = useClipboard({ timeout: LOG_VIEWER.copiedMs });
	const count = (value: number) => (
		<Badge size="xs" variant="transparent" color="gray" px={0}>
			{i18n.number(value)}
		</Badge>
	);
	const download = () => {
		if (!options.download) return;
		const blob = new Blob([`${visibleText()}\n`], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = `${options.download}.log`;
		link.click();
		URL.revokeObjectURL(url);
	};
	return (
		<Group gap="xs" wrap="wrap" className="log-toolbar">
			{options.filter && (
				<SegmentedControl
					size="xs"
					value={level}
					onChange={(value) => onLevel(value as LevelFilter)}
					aria-label={i18n._("Filter by level")}
					data={[
						{
							value: "all",
							label: (
								<Group gap={4} wrap="nowrap">
									{i18n._("All")}
									{count(total)}
								</Group>
							),
						},
						...LOG_LEVEL_IDS.map((id) => ({
							value: id,
							label: (
								<Group gap={4} wrap="nowrap">
									{i18n._(logLevels[id].filterLabel)}
									{count(counts[id])}
								</Group>
							),
						})),
					]}
				/>
			)}
			{options.search && (
				<TextInput
					size="xs"
					value={search}
					onChange={(event) => onSearch(event.currentTarget.value)}
					placeholder={i18n._("Search logs…")}
					aria-label={i18n._("Search logs")}
					leftSection={<Search size={14} />}
					rightSection={
						search ? (
							<ActionIcon
								size="sm"
								variant="subtle"
								color="gray"
								aria-label={i18n._("Clear search")}
								onClick={() => onSearch("")}
							>
								<X size={14} />
							</ActionIcon>
						) : undefined
					}
					style={{ flex: "1 1 160px", maxWidth: 320 }}
				/>
			)}
			<Group gap={6} ml="auto" wrap="nowrap">
				{options.raw && (
					<Switch
						size="xs"
						label={i18n._("Raw")}
						checked={raw}
						onChange={(event) => onRaw(event.currentTarget.checked)}
					/>
				)}
				{options.copy && (
					<Tooltip
						label={
							clipboard.copied ? i18n._("Copied") : i18n._("Copy visible logs")
						}
						withArrow
					>
						<ActionIcon
							variant="default"
							aria-label={i18n._("Copy visible logs")}
							onClick={() => clipboard.copy(visibleText())}
						>
							{clipboard.copied ? <Check size={14} /> : <Copy size={14} />}
						</ActionIcon>
					</Tooltip>
				)}
				{options.download && (
					<Tooltip label={i18n._("Download visible logs")} withArrow>
						<ActionIcon
							variant="default"
							aria-label={i18n._("Download visible logs")}
							onClick={download}
						>
							<Download size={14} />
						</ActionIcon>
					</Tooltip>
				)}
			</Group>
		</Group>
	);
};

/**
 * Virtualized monospace log view used by job logs, app/service logs and
 * task output. Each row shows time, level badge and message; only visible
 * rows are rendered. It sticks to the bottom while following and stops
 * following when the user scrolls up. An optional toolbar filters by
 * level, searches, toggles raw lines and copies/downloads what is shown.
 */
export const LogViewer: React.FC<{
	entries: LogEntry[];
	/** Total height (toolbar included). */
	height?: number | string;
	/** Fit short output, up to `LOG_VIEWER.compactMaxHeight`. */
	autoHeight?: boolean;
	format?: LogFormat;
	/** Lines start with a Compose `service |` prefix (raw format). */
	composePrefix?: boolean;
	/** `true` turns on filter, search, copy (and raw for raw format). */
	toolbar?: boolean | LogToolbarOptions;
	emptyText?: string;
}> = ({
	entries,
	height = LOG_VIEWER.height,
	autoHeight = false,
	format = "plain",
	composePrefix = false,
	toolbar = false,
	emptyText,
}) => {
	const { i18n } = useLingui();
	const options: LogToolbarOptions =
		toolbar === true
			? { filter: true, search: true, copy: true, raw: format === "raw" }
			: toolbar || {};
	const hasToolbar = Object.values(options).some(Boolean);

	const viewportRef = useRef<HTMLDivElement>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const [viewportHeight, setViewportHeight] = useState<number>(
		LOG_VIEWER.height,
	);
	const [follow, setFollow] = useState(true);
	const [level, setLevel] = useState<LevelFilter>("all");
	const [searchInput, setSearchInput] = useState("");
	const search = useDeferredValue(searchInput.trim());
	const [raw, setRaw] = useState(false);

	const rows = useLogRows(entries, format, composePrefix);
	const counts = useMemo(() => {
		const result = Object.fromEntries(
			LOG_LEVEL_IDS.map((id) => [id, 0]),
		) as Record<LogLevel, number>;
		for (const row of rows) if (row.level) result[row.level] += 1;
		return result;
	}, [rows]);
	const shown = useMemo(() => {
		const needle = search.toLowerCase();
		if (level === "all" && !needle) return rows;
		return rows.filter(
			(row) =>
				(level === "all" || row.level === level) &&
				(!needle ||
					(raw ? row.raw : row.message).toLowerCase().includes(needle)),
		);
	}, [rows, level, search, raw]);
	const filtered = shown.length !== rows.length;

	useEffect(() => {
		const element = viewportRef.current;
		if (!element) return;
		const observer = new ResizeObserver(() =>
			setViewportHeight(element.clientHeight),
		);
		observer.observe(element);
		setViewportHeight(element.clientHeight);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		const element = viewportRef.current;
		if (follow && element && shown.length) {
			element.scrollTop = element.scrollHeight;
		}
	}, [shown.length, follow]);

	const onScroll = useCallback(() => {
		const element = viewportRef.current;
		if (!element) return;
		setScrollTop(element.scrollTop);
		const atBottom =
			element.scrollHeight - element.scrollTop - element.clientHeight <
			LOG_VIEWER.rowHeight * 2;
		setFollow(atBottom);
	}, []);

	const { rowHeight, overscan } = LOG_VIEWER;
	const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
	const end = Math.min(
		shown.length,
		Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan,
	);
	const visible = useMemo(() => shown.slice(start, end), [shown, start, end]);
	const visibleText = useCallback(
		() => shown.map((row) => rowText(row, format, raw)).join("\n"),
		[shown, format, raw],
	);
	// Two border pixels; an empty log keeps room for its message.
	const viewerHeight = autoHeight
		? Math.min(
				LOG_VIEWER.compactMaxHeight,
				Math.max(shown.length, 2) * rowHeight + 2,
			)
		: undefined;

	return (
		<Box
			style={{
				height: autoHeight ? undefined : height,
				display: "flex",
				flexDirection: "column",
				gap: "var(--mantine-spacing-xs)",
			}}
		>
			{hasToolbar && (
				<LogToolbar
					options={options}
					counts={counts}
					total={rows.length}
					level={level}
					onLevel={setLevel}
					search={searchInput}
					onSearch={setSearchInput}
					raw={raw}
					onRaw={setRaw}
					visibleText={visibleText}
				/>
			)}
			<Box
				pos="relative"
				className="log-viewer"
				style={{
					flex: autoHeight ? undefined : 1,
					minHeight: 0,
					height: viewerHeight,
				}}
			>
				<div
					ref={viewportRef}
					onScroll={onScroll}
					style={{ height: "100%", overflow: "auto" }}
					role="log"
					aria-live="polite"
				>
					{shown.length === 0 ? (
						<Text size="xs" c="dimmed" p="sm" ff="monospace">
							{filtered
								? i18n._("No matching lines.")
								: (emptyText ?? i18n._("Waiting for logs..."))}
						</Text>
					) : (
						<div
							style={{
								height: shown.length * rowHeight,
								position: "relative",
								minWidth: "100%",
							}}
						>
							<div
								style={{
									position: "absolute",
									top: start * rowHeight,
									left: 0,
									right: 0,
								}}
							>
								{visible.map((row) => (
									<LogLine key={row.key} row={row} raw={raw} search={search} />
								))}
							</div>
						</div>
					)}
				</div>
				{!follow && shown.length > 0 && (
					<Group pos="absolute" bottom={8} right={16}>
						<Tooltip label={i18n._("Follow")} withArrow>
							<ActionIcon
								variant="filled"
								radius="xl"
								aria-label={i18n._("Follow")}
								onClick={() => {
									setFollow(true);
									const element = viewportRef.current;
									if (element) element.scrollTop = element.scrollHeight;
								}}
							>
								<ArrowDownToLine size={16} />
							</ActionIcon>
						</Tooltip>
					</Group>
				)}
			</Box>
		</Box>
	);
};
