import { useLingui } from "@lingui/react";
import {
	Badge,
	Button,
	Drawer,
	Group,
	Paper,
	Stack,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { CircleDot, Maximize2, Minimize2, TerminalSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { chunkTerminalInput } from "#/libs/terminal.ts";
import { ACCENT, terminalTheme, toneColors } from "#/theme/tokens.ts";

export interface TerminalDrawerProps {
	opened: boolean;
	onClose: () => void;
	/** WebSocket path, e.g. `/api/servers/<id>/terminal`. */
	wsPath: string;
	/** Title shown in the drawer header. */
	serverName: string;
}

type ConnectionState = "connecting" | "connected" | "disconnected";

/**
 * Bottom drawer hosting an xterm.js terminal bridged to a server-side PTY
 * over a WebSocket. The terminal and socket live only while the drawer is
 * open; closing it tears both down (the server ends the remote shell).
 */
export function TerminalDrawer({
	opened,
	onClose,
	wsPath,
	serverName,
}: TerminalDrawerProps) {
	const { i18n } = useLingui();
	// Callback-ref state (not a ref object) so the effect re-runs once the
	// Drawer has actually mounted its content and the element exists.
	const [container, setContainer] = useState<HTMLDivElement | null>(null);
	const termRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const [status, setStatus] = useState<ConnectionState>("disconnected");
	const [expanded, setExpanded] = useState(false);

	useEffect(() => {
		if (!opened || !container) return;

		setStatus("connecting");

		const term = new Terminal({
			cursorBlink: true,
			fontFamily: terminalTheme.fontFamily,
			fontSize: terminalTheme.fontSize,
			lineHeight: terminalTheme.lineHeight,
			fontWeight: terminalTheme.fontWeight,
			theme: terminalTheme.colors,
		});
		const fitAddon = new FitAddon();
		term.loadAddon(fitAddon);
		term.open(container);
		// Fit after layout: the drawer is still animating in, so measuring
		// synchronously would size the terminal against a 0-height box.
		requestAnimationFrame(() => {
			try {
				fitAddon.fit();
			} catch {
				// ignore
			}
		});

		termRef.current = term;
		fitAddonRef.current = fitAddon;

		// Same-origin socket: the session cookie authenticates the upgrade and
		// the server rejects cross-origin upgrades.
		const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
		// The page locale rides along: the locale cookie can differ from the
		// URL's (e.g. /vi with an older cookie), and server banners follow it.
		const url = new URL(wsPath, window.location.href);
		url.protocol = proto;
		url.searchParams.set("locale", i18n.locale);
		const wsUrl = url.toString();
		const ws = new WebSocket(wsUrl);
		wsRef.current = ws;

		// Client-side status line in the terminal (server lines come as output).
		const notice = (text: string, tone: keyof typeof terminalTheme.notice) =>
			term.write(`\r\n\x1b[${terminalTheme.notice[tone]}m[${text}]\x1b[0m\r\n`);

		// Wire protocol (see libs/terminal.ts): client sends JSON
		// `{ type: "input", data }` / `{ type: "resize", cols, rows }`; the
		// server sends raw terminal output as text frames (and a `[nitrobase]`
		// line if it ever drops an oversized frame).
		ws.onopen = () => {
			setStatus("connected");
			try {
				fitAddon.fit();
			} catch {
				// ignore
			}
			ws.send(
				JSON.stringify({
					type: "resize",
					cols: term.cols,
					rows: term.rows,
				}),
			);
		};

		ws.onmessage = (event) => {
			if (typeof event.data === "string") {
				term.write(event.data);
			}
		};

		ws.onclose = (event) => {
			setStatus("disconnected");
			// 4403: the member's access in the team changed (removed/demoted).
			if (event.code === 4403) {
				notice(
					i18n._("Your access in this team changed. Reload the page."),
					"error",
				);
			} else {
				notice(i18n._("Connection closed"), "info");
			}
		};

		ws.onerror = () => {
			setStatus("disconnected");
			notice(i18n._("WebSocket connection error"), "error");
		};

		// Large pastes are split into frames under the server limit; sends on
		// one socket are delivered in order, so the shell sees the full text.
		const onDataDisposable = term.onData((data) => {
			if (ws.readyState !== WebSocket.OPEN) return;
			for (const frame of chunkTerminalInput(data)) ws.send(frame);
		});

		const handleResize = () => {
			try {
				fitAddon.fit();
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(
						JSON.stringify({
							type: "resize",
							cols: term.cols,
							rows: term.rows,
						}),
					);
				}
			} catch {
				// ignore resize error on unmount
			}
		};

		// The container also changes size when the drawer is expanded, which
		// does not fire a window resize, hence the observer.
		const resizeObserver = new ResizeObserver(() => handleResize());
		resizeObserver.observe(container);

		window.addEventListener("resize", handleResize);

		return () => {
			window.removeEventListener("resize", handleResize);
			resizeObserver.disconnect();
			onDataDisposable.dispose();
			// Detach first: a late close/error/message must not write into the
			// disposed terminal or flip the status of the next session.
			ws.onopen = null;
			ws.onmessage = null;
			ws.onclose = null;
			ws.onerror = null;
			try {
				ws.close();
			} catch {
				// ignore
			}
			try {
				term.dispose();
			} catch {
				// ignore
			}
			termRef.current = null;
			fitAddonRef.current = null;
			wsRef.current = null;
			setStatus("disconnected");
		};
	}, [opened, wsPath, container, i18n]);

	const badgeColor =
		toneColors[
			status === "connected"
				? "success"
				: status === "connecting"
					? "warning"
					: "neutral"
		];
	const badgeLabel =
		status === "connected"
			? i18n._("Connected")
			: status === "connecting"
				? i18n._("Connecting...")
				: i18n._("Disconnected");

	return (
		<Drawer
			opened={opened}
			onClose={onClose}
			position="bottom"
			size={expanded ? "100%" : "60%"}
			title={
				<Group gap="sm">
					<TerminalSquare
						size={18}
						color={`var(--mantine-color-${ACCENT}-0)`}
					/>
					<Title order={4}>{i18n._("Terminal")}</Title>
					<Badge
						color={badgeColor}
						variant="light"
						size="sm"
						leftSection={<CircleDot size={10} />}
					>
						{badgeLabel}
					</Badge>
					<Text size="sm" c="dimmed">
						{serverName}
					</Text>
				</Group>
			}
		>
			<Stack
				gap="xs"
				style={{
					height: expanded ? "calc(100vh - 80px)" : "calc(60vh - 80px)",
				}}
			>
				<Paper
					ref={setContainer}
					px="md"
					py="sm"
					bg={terminalTheme.colors.background}
					style={{
						flex: 1,
						...terminalTheme.surface,
						overflow: "hidden",
					}}
				/>
				<Group justify="flex-end">
					<Tooltip
						label={
							expanded
								? i18n._("Restore terminal size")
								: i18n._("Expand terminal")
						}
					>
						<Button
							variant="default"
							size="xs"
							aria-label={
								expanded
									? i18n._("Restore terminal size")
									: i18n._("Expand terminal")
							}
							onClick={() => setExpanded((value) => !value)}
						>
							{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
						</Button>
					</Tooltip>
					<Button variant="default" size="xs" onClick={onClose}>
						{i18n._("Close")}
					</Button>
				</Group>
			</Stack>
		</Drawer>
	);
}
