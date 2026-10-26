import { useLingui } from "@lingui/react";
import { Button, SimpleGrid, Stack, Text, TextInput } from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Search, Server } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { useUnreachableServers } from "#/components/monitoring/ServerLiveStatus";
import { ServerCard } from "#/components/servers/ServerCard";
import { ServerFormModal } from "#/components/servers/ServerFormModal";
import { useCan } from "#/components/teams/useCan";
import { EmptyState } from "#/components/ui/EmptyState";
import { PageHeader } from "#/components/ui/PageHeader";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { APP_NAME } from "#/config/shared.ts";
import type { ServerDTO } from "#/features/servers/schema.ts";
import { deleteServerFn } from "#/features/servers/servers.functions.ts";
import {
	serverSummariesQueryOptions,
	serversQueryOptions,
} from "#/features/servers/servers.query.ts";

/**
 * Server list. The loader primes the servers query so the grid renders from
 * cache, and returns the localized breadcrumb label for the layout.
 */
/** Lists longer than this get a search box. */
const SEARCH_FROM = 6;

/** `?add=true` opens the add form (command palette). */
const SearchSchema = z.object({ add: z.boolean().optional() });

export const Route = createFileRoute("/{-$locale}/_authed/servers/")({
	validateSearch: SearchSchema,
	// Shared with the loader and component through route context.
	context: () => ({
		serversQueryOptions: serversQueryOptions,
	}),
	loader: async ({ context }) => {
		const { i18n, queryClient, serversQueryOptions } = context;
		await queryClient.query(serversQueryOptions);
		return {
			crumb: i18n._("Servers"),
		};
	},

	component: Servers,
});

function Servers() {
	const { i18n } = useLingui();
	const unreachable = useUnreachableServers();
	const { serversQueryOptions, queryClient } = Route.useRouteContext();
	const { data: servers = [] } = useQuery(serversQueryOptions);
	const { data: summaries } = useQuery(serverSummariesQueryOptions);
	const summaryOf = new Map(
		(summaries?.servers ?? []).map((item) => [item.serverId, item]),
	);
	const [query, setQuery] = useState("");
	const needle = query.trim().toLowerCase();
	const shown = needle
		? servers.filter((server) =>
				[server.name, server.host].some((text) =>
					text.toLowerCase().includes(needle),
				),
			)
		: servers;

	const {
		mutate: removeServer,
		isPending,
		variables: deletingId,
	} = useAppMutation({
		mutationFn: async (serverId: string) =>
			await deleteServerFn({ data: serverId }),
		success: i18n._("Server removed."),
		onSuccess: () => queryClient.invalidateQueries(serversQueryOptions),
	});

	const openDeleteModal = (serverId: string) =>
		modals.openConfirmModal({
			title: i18n._("Delete this server"),
			centered: true,
			children: (
				<Stack>
					<Text size="sm">
						{i18n._(
							"This removes the server from {appName}. Nothing on the server itself is deleted: containers, data and the installed SSH key stay in place.",
							{ appName: APP_NAME },
						)}
					</Text>
				</Stack>
			),
			labels: {
				confirm: i18n._("Confirm"),
				cancel: i18n._("Cancel"),
			},
			confirmProps: { color: "red" },
			onConfirm: () => removeServer(serverId),
		});

	const { add } = Route.useSearch();
	const navigate = Route.useNavigate();
	// Kept while closing so the title doesn't flip during the transition.
	const [form, setForm] = useState<{ opened: boolean; server?: ServerDTO }>({
		opened: false,
	});
	const openForm = (server?: ServerDTO) => setForm({ opened: true, server });
	const closeForm = () => {
		setForm((prev) => ({ ...prev, opened: false }));
		if (add) void navigate({ search: {}, replace: true });
	};
	const can = useCan();
	const manage = can("server.manage");
	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("Servers")}
				description={i18n._("Manage your VPS servers")}
				actions={
					manage && (
						<Button leftSection={<Plus size={16} />} onClick={() => openForm()}>
							{i18n._("Add server")}
						</Button>
					)
				}
			/>

			{servers.length === 0 ? (
				<EmptyState
					withCard
					icon={Server}
					title={i18n._("No servers yet")}
					description={i18n._(
						"Add your first VPS server to start deploying apps.",
					)}
					actionLabel={manage ? i18n._("Add Server") : undefined}
					action={manage ? () => openForm() : undefined}
				/>
			) : (
				<Stack gap="md">
					{servers.length > SEARCH_FROM && (
						<TextInput
							leftSection={<Search size={16} />}
							placeholder={i18n._("Search by name or host")}
							aria-label={i18n._("Search servers")}
							value={query}
							onChange={(event) => setQuery(event.currentTarget.value)}
							maw={360}
						/>
					)}
					{shown.length === 0 ? (
						<Text size="sm" c="dimmed">
							{i18n._("No servers match your search.")}
						</Text>
					) : (
						<SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
							{shown.map((server) => (
								<ServerCard
									key={server.id}
									server={server}
									summary={summaryOf.get(server.id)}
									thresholds={summaries?.thresholds}
									unreachable={unreachable}
									manage={manage}
									deleting={isPending && deletingId === server.id}
									onEdit={() => openForm(server)}
									onDelete={() => openDeleteModal(server.id)}
								/>
							))}
						</SimpleGrid>
					)}
				</Stack>
			)}
			<ServerFormModal
				opened={form.opened || !!add}
				onClose={closeForm}
				server={form.server}
			/>
		</Stack>
	);
}
