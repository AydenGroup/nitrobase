import { useLingui } from "@lingui/react";
import { Button, Kbd, Text } from "@mantine/core";
import { useOs } from "@mantine/hooks";
import {
	Spotlight,
	type SpotlightActionGroupData,
	spotlight,
} from "@mantine/spotlight";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AppWindow, RefreshCw, Rocket, Search, Server } from "lucide-react";
import { useMemo } from "react";
import { openBootstrapConfirm } from "#/components/servers/BootstrapConfirm";
import { useCan } from "#/components/teams/useCan";
import { notifications } from "#/components/ui/Notifications";
import { commandActions } from "#/config/commands.ts";
import { navSections } from "#/config/navigation.ts";
import { serverStatusMeta } from "#/config/status.ts";
import { appActionFn } from "#/features/apps/apps.functions.ts";
import { appsQueryOptions } from "#/features/apps/apps.query.ts";
import { startServerActionFn } from "#/features/servers/servers.functions.ts";
import { serversQueryOptions } from "#/features/servers/servers.query.ts";
import { localizePath } from "#/libs/i18n";

/** Key of the palette shortcut (with Ctrl, or Cmd on Apple systems). */
const PALETTE_KEY = "K";

/** The palette shortcut as shown to this OS ("⌘ K", "Ctrl K"). */
export function usePaletteShortcut(): string {
	const { i18n } = useLingui();
	// "undetermined" while rendering on the server: Ctrl until known.
	const os = useOs();
	const modifier = os === "macos" || os === "ios" ? "⌘" : i18n._("Ctrl");
	return `${modifier} ${PALETTE_KEY}`;
}

/** Header button that opens the palette (Ctrl/Cmd+K). */
export const CommandPaletteButton: React.FC = () => {
	const { i18n } = useLingui();
	const shortcut = usePaletteShortcut();
	return (
		<Button
			variant="default"
			size="xs"
			leftSection={<Search size={14} />}
			rightSection={
				<Kbd size="xs" visibleFrom="sm">
					{shortcut}
				</Kbd>
			}
			onClick={() => spotlight.open()}
			aria-label={i18n._("Search")}
		>
			<Text size="xs" visibleFrom="sm">
				{i18n._("Search")}
			</Text>
		</Button>
	);
};

/**
 * Ctrl/Cmd+K palette: pages (navigation registry), apps and servers (live
 * queries) and actions (command registry + per-entity actions).
 */
export const CommandPalette: React.FC = () => {
	const { i18n } = useLingui();
	const routerNavigate = useNavigate();
	const { data: apps = [] } = useQuery(appsQueryOptions);
	const { data: servers = [] } = useQuery(serversQueryOptions);
	const can = useCan();

	const groups = useMemo<SpotlightActionGroupData[]>(() => {
		const navigate = (to: string, search?: Record<string, unknown>) =>
			routerNavigate({
				to: localizePath(to) as never,
				search: search as never,
			});
		const run = (label: string, task: () => Promise<unknown>) =>
			task()
				.then(() =>
					notifications.success({
						message: i18n._("{label} started", { label }),
					}),
				)
				.catch((error: Error) =>
					notifications.error({ message: error.message }),
				);

		return [
			{
				group: i18n._("Actions"),
				actions: [
					...commandActions
						.filter((action) => !action.permission || can(action.permission))
						.map((action) => ({
							id: action.id,
							label: i18n._(action.label),
							description: action.description
								? i18n._(action.description)
								: undefined,
							leftSection: <action.icon size={16} />,
							onClick: () => void action.run({ navigate }),
						})),
					...(can("app.deploy") ? apps : []).map((app) => ({
						id: `redeploy-${app.id}`,
						label: i18n._("Redeploy {name}", { name: app.name }),
						leftSection: <RefreshCw size={16} />,
						onClick: () =>
							void run(app.name, () =>
								appActionFn({ data: { appId: app.id, action: "redeploy" } }),
							),
					})),
					// Only where the status model suggests it (reachable / failed).
					...servers
						.filter(
							(server) =>
								can("server.manage") &&
								serverStatusMeta(server).action === "bootstrap",
						)
						.map((server) => ({
							id: `bootstrap-${server.id}`,
							label: i18n._("Bootstrap {name}", { name: server.name }),
							leftSection: <Rocket size={16} />,
							onClick: () =>
								openBootstrapConfirm(
									i18n,
									server,
									({ takeover }) =>
										void run(server.name, () =>
											startServerActionFn({
												data: {
													serverId: server.id,
													action: "bootstrap",
													takeover,
												},
											}),
										),
								),
						})),
				],
			},
			{
				group: i18n._("Apps"),
				actions: apps.map((app) => ({
					id: `app-${app.id}`,
					label: app.name,
					description: app.templateId,
					leftSection: <AppWindow size={16} />,
					onClick: () => void navigate(`/apps/${app.id}`),
				})),
			},
			{
				group: i18n._("Servers"),
				actions: servers.map((server) => ({
					id: `server-${server.id}`,
					label: server.name,
					description: server.host,
					leftSection: <Server size={16} />,
					onClick: () => void navigate(`/servers/${server.id}`),
				})),
			},
			{
				group: i18n._("Pages"),
				actions: navSections.flatMap((section) =>
					section.items
						.filter((item) => !item.permission || can(item.permission))
						.map((item) => ({
							id: `page-${item.to}`,
							label: i18n._(item.label),
							description: i18n._(section.label),
							leftSection: <item.icon size={16} />,
							onClick: () => void navigate(item.to),
						})),
				),
			},
		];
	}, [apps, servers, i18n, routerNavigate, can]);

	return (
		<Spotlight
			actions={groups}
			shortcut={[`mod + ${PALETTE_KEY}`]}
			nothingFound={i18n._("Nothing found")}
			highlightQuery
			limit={40}
			scrollable
			maxHeight={480}
			searchProps={{
				leftSection: <Search size={16} />,
				placeholder: i18n._("Search apps, servers, pages and actions..."),
			}}
		/>
	);
};
