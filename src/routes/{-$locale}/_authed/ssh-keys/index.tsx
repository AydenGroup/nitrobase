import { useLingui } from "@lingui/react";
import { Button, SimpleGrid, Stack, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, Plus } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { SSHKeyCard } from "#/components/ssh_keys/SSHKeyCard";
import { SSHKeyFormModal } from "#/components/ssh_keys/SSHKeyFormModal";
import { useCan } from "#/components/teams/useCan";
import { EmptyState } from "#/components/ui/EmptyState";
import { PageHeader } from "#/components/ui/PageHeader";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { serversQueryOptions } from "#/features/servers/servers.query.ts";
import type { SSHKeyDTO } from "#/features/ssh_keys/schema.ts";
import { deleteSSHKeyFn } from "#/features/ssh_keys/ssh_keys.functions.ts";
import { sshKeysQueryOptions } from "#/features/ssh_keys/ssh_keys.query.ts";

/**
 * SSH key library. The loader primes the key list so the page renders from
 * cache, and returns the localized breadcrumb label for the layout.
 */
/** `?add=true` opens the add form (command palette). */
const SearchSchema = z.object({ add: z.boolean().optional() });

export const Route = createFileRoute("/{-$locale}/_authed/ssh-keys/")({
	validateSearch: SearchSchema,
	// Exposed through route context so the loader and component share the
	// same query options instance.
	context: () => ({
		sshKeysQueryOptions,
	}),
	loader: async ({ context }) => {
		// `i18n` comes from router context and already has the URL locale active.
		const { i18n, queryClient, sshKeysQueryOptions } = context;
		await queryClient.query(sshKeysQueryOptions);
		return {
			crumb: i18n._("SSH Keys"),
		};
	},
	component: SSHKeys,
});

function SSHKeys() {
	const { i18n } = useLingui();
	const { sshKeysQueryOptions, queryClient } = Route.useRouteContext();
	const { data: keys = [] } = useQuery(sshKeysQueryOptions);

	const {
		mutate: removeKey,
		isPending,
		variables: deletingId,
	} = useAppMutation({
		// The server refuses to delete a key still referenced by a server.
		mutationFn: async (keyId: string) => await deleteSSHKeyFn({ data: keyId }),
		success: i18n._("SSH key removed."),
		onSuccess: () => queryClient.invalidateQueries(sshKeysQueryOptions),
	});

	const openDeleteModal = (keyId: string, keyName: string) =>
		modals.openConfirmModal({
			title: <Text>{i18n._("Delete SSH key")}</Text>,
			centered: true,
			children: (
				<Stack>
					<Text size="sm">
						{i18n._(
							'Are you sure you want to delete "{keyName}"? Keys still used by a server cannot be deleted.',
							{ keyName },
						)}
					</Text>
				</Stack>
			),
			labels: {
				confirm: i18n._("Delete"),
				cancel: i18n._("Cancel"),
			},
			confirmProps: { color: "red" },
			onConfirm: () => removeKey(keyId),
		});

	const { add } = Route.useSearch();
	const navigate = Route.useNavigate();
	// Kept while closing so the title doesn't flip during the transition.
	const [form, setForm] = useState<{ opened: boolean; sshKey?: SSHKeyDTO }>({
		opened: false,
	});
	const openForm = (sshKey?: SSHKeyDTO) => setForm({ opened: true, sshKey });
	const closeForm = () => {
		setForm((prev) => ({ ...prev, opened: false }));
		if (add) void navigate({ search: {}, replace: true });
	};
	const can = useCan();
	const manage = can("ssh_key.manage");
	const canSeeServers = can("server.view");
	const { data: servers = [] } = useQuery({
		...serversQueryOptions,
		enabled: canSeeServers,
	});
	const usersOf = (keyId: string) =>
		servers
			.filter((server) => server.sshKeyId === keyId)
			.map((server) => server.name);

	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("SSH Keys")}
				description={i18n._("Manage SSH keys to securely access your servers")}
				actions={
					manage && (
						<Button leftSection={<Plus size={16} />} onClick={() => openForm()}>
							{i18n._("Add SSH key")}
						</Button>
					)
				}
			/>

			{keys.length === 0 ? (
				<EmptyState
					withCard
					icon={KeyRound}
					title={i18n._("No SSH keys yet")}
					description={i18n._(
						"Add your SSH keys once to reuse them when creating servers.",
					)}
					actionLabel={manage ? i18n._("Add SSH Key") : undefined}
					action={manage ? () => openForm() : undefined}
				/>
			) : (
				<SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
					{keys.map((key) => (
						<SSHKeyCard
							key={key.id}
							sshKey={key}
							usedBy={canSeeServers ? usersOf(key.id) : undefined}
							manage={manage}
							deleting={isPending && deletingId === key.id}
							onEdit={() => openForm(key)}
							onDelete={() => openDeleteModal(key.id, key.name)}
						/>
					))}
				</SimpleGrid>
			)}
			<SSHKeyFormModal
				opened={form.opened || !!add}
				onClose={closeForm}
				sshKey={form.sshKey}
			/>
		</Stack>
	);
}
