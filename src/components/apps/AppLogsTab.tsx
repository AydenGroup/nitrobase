import { useLingui } from "@lingui/react";
import {
	Badge,
	Button,
	Group,
	NumberInput,
	Select,
	Stack,
	Switch,
} from "@mantine/core";
import {
	Download,
	Pause,
	Play,
	ScrollText,
	TerminalSquare,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { TerminalDrawer } from "#/components/servers/TerminalDrawer";
import { EmptyState } from "#/components/ui/EmptyState";
import { LogViewer } from "#/components/ui/LogViewer";
import { SectionCard } from "#/components/ui/SectionCard";
import type { AppOverview } from "#/features/apps/schema.ts";
import { closeOnSessionEnded } from "#/libs/session-ended.ts";

const MAX_LINES = 5000;

export const AppLogsTab: React.FC<{
	overview: AppOverview;
	/** Lock the view to one service (e.g. a plugin's own logs panel). */
	fixedService?: string;
	height?: string;
}> = ({ overview, fixedService, height = "calc(100dvh - 360px)" }) => {
	const { i18n } = useLingui();
	const { app, services } = overview;
	const [service, setService] = useState<string | null>(
		fixedService ?? (services.length === 1 ? services[0] : null),
	);
	const [tail, setTail] = useState<number>(200);
	// One service usually prints its own timestamps; all services need ours.
	const [timestamps, setTimestamps] = useState<boolean | null>(null);
	const showTimestamps = timestamps ?? !service;
	const [live, setLive] = useState(true);
	const [lines, setLines] = useState<string[]>([]);
	const [state, setState] = useState<
		"connecting" | "streaming" | "ended" | "error"
	>("connecting");
	const [terminalService, setTerminalService] = useState<string | null>(null);

	const params = new URLSearchParams({
		tail: String(tail),
		timestamps: showTimestamps ? "1" : "0",
	});
	if (service) params.set("service", service);
	const query = params.toString();
	const base = `/api/apps/${encodeURIComponent(app.id)}/logs`;

	useEffect(() => {
		if (!live || services.length === 0) return;
		setLines([]);
		setState("connecting");
		const es = new EventSource(`${base}?${query}`);
		closeOnSessionEnded(es);
		es.addEventListener("open", () => setState("streaming"));
		es.addEventListener("log", (event) => {
			let line: string;
			try {
				line = JSON.parse((event as MessageEvent).data) as string;
			} catch {
				line = (event as MessageEvent).data;
			}
			setLines((prev) => {
				const next = [...prev, line];
				return next.length > MAX_LINES
					? next.slice(next.length - MAX_LINES)
					: next;
			});
		});
		const stop = (next: "ended" | "error") => {
			es.close();
			setState(next);
		};
		es.addEventListener("end", () => stop("ended"));
		es.addEventListener("failure", () => stop("error"));
		es.addEventListener("error", () => {
			if (es.readyState === EventSource.CLOSED) setState("error");
		});
		return () => es.close();
	}, [live, base, query, services.length]);

	const entries = useMemo(
		() => lines.map((line, index) => ({ key: index, line })),
		[lines],
	);

	if (services.length === 0) {
		return (
			<SectionCard>
				<EmptyState
					compact
					icon={ScrollText}
					title={i18n._("Logs")}
					description={i18n._("Available after the first deploy.")}
				/>
			</SectionCard>
		);
	}

	return (
		<Stack gap="md">
			<Group align="flex-end">
				{!fixedService && (
					<Select
						label={i18n._("Service")}
						placeholder={i18n._("All services")}
						data={services}
						value={service}
						onChange={setService}
						clearable
						w={220}
					/>
				)}
				<NumberInput
					label={i18n._("Last lines")}
					value={tail}
					onChange={(value) => setTail(typeof value === "number" ? value : 200)}
					min={0}
					max={5000}
					step={100}
					w={140}
				/>
				<Switch
					label={i18n._("Timestamps")}
					checked={showTimestamps}
					onChange={(event) => {
						const checked = event.currentTarget.checked;
						setTimestamps(checked);
					}}
					mb={8}
				/>
				<Button
					variant="light"
					leftSection={live ? <Pause size={16} /> : <Play size={16} />}
					onClick={() => setLive((value) => !value)}
				>
					{live ? i18n._("Pause") : i18n._("Follow")}
				</Button>
				<Button
					variant="default"
					component="a"
					href={`${base}?${query}&download=1`}
					leftSection={<Download size={16} />}
				>
					{i18n._("Download")}
				</Button>
				<Button
					variant="default"
					leftSection={<TerminalSquare size={16} />}
					disabled={!service}
					title={service ? undefined : i18n._("Select a service")}
					onClick={() => setTerminalService(service)}
				>
					{i18n._("Terminal")}
				</Button>
				<Badge
					ml="auto"
					variant="light"
					color={
						state === "streaming" ? "green" : state === "error" ? "red" : "gray"
					}
				>
					{state === "streaming"
						? i18n._("Live")
						: state === "connecting"
							? i18n._("Connecting")
							: state === "ended"
								? i18n._("Ended")
								: i18n._("Disconnected")}
				</Badge>
			</Group>
			<LogViewer
				entries={entries}
				height={height}
				format="raw"
				composePrefix={!service}
				toolbar
			/>
			<TerminalDrawer
				opened={terminalService !== null}
				onClose={() => setTerminalService(null)}
				wsPath={`/api/apps/${encodeURIComponent(app.id)}/terminal?service=${encodeURIComponent(terminalService ?? "")}`}
				serverName={`${app.name} · ${terminalService ?? ""}`}
			/>
		</Stack>
	);
};
