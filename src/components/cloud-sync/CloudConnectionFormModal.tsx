import { useLingui } from "@lingui/react";
import {
	Button,
	Group,
	Modal,
	Select,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
	SchemaFormFields,
	useSchemaFormIssues,
} from "#/components/ui/SchemaFormFields";
import { useAppMutation } from "#/components/ui/useAppMutation";
import {
	cloudSyncProviders,
	getCloudSyncProvider,
	providerFields,
} from "#/config/cloud-sync.ts";
import {
	createCloudConnectionFn,
	updateCloudConnectionFn,
} from "#/features/cloud-sync/cloud-sync.functions.ts";
import { cloudConnectionsQueryOptions } from "#/features/cloud-sync/cloud-sync.query.ts";
import type { CloudConnectionDTO } from "#/features/cloud-sync/schema.ts";

/** Add/edit a cloud connection; the form comes from the provider schema. */
export const CloudConnectionFormModal: React.FC<{
	opened: boolean;
	onClose: () => void;
	/** Edit this connection (provider is fixed); omit to create. */
	connection?: CloudConnectionDTO | null;
}> = ({ opened, onClose, connection }) => {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const firstProvider = cloudSyncProviders[0]?.id ?? "";
	const [providerId, setProviderId] = useState(
		connection?.provider ?? firstProvider,
	);
	const [name, setName] = useState(connection?.name ?? "");
	const [config, setConfig] = useState<Record<string, unknown>>(
		connection?.config ?? {},
	);
	const issues = useSchemaFormIssues();
	const clearIssues = issues.clear;
	useEffect(() => {
		if (!opened) return;
		setProviderId(connection?.provider ?? firstProvider);
		setName(connection?.name ?? "");
		setConfig(connection?.config ?? {});
		clearIssues();
	}, [opened, connection, clearIssues, firstProvider]);
	const provider = getCloudSyncProvider(providerId);
	const fields = provider ? providerFields(provider) : [];

	const save = useAppMutation({
		mutationFn: async () =>
			connection
				? await updateCloudConnectionFn({
						data: { id: connection.id, name, provider: providerId, config },
					})
				: await createCloudConnectionFn({
						data: { name, provider: providerId, config },
					}),
		success: i18n._("Connection saved"),
		field: "config",
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: cloudConnectionsQueryOptions.queryKey,
			});
			onClose();
		},
	});

	const submit = () => {
		if (issues.check(provider?.schema, config, !!connection)) save.mutate();
	};

	const setField = (field: string, value: unknown) => {
		save.clearFieldError();
		issues.clear(field);
		setConfig((prev) => ({ ...prev, [field]: value }));
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={connection ? i18n._("Edit connection") : i18n._("Add connection")}
			size="lg"
			centered
		>
			<Stack>
				<Select
					label={i18n._("Provider")}
					data={cloudSyncProviders.map((item) => ({
						value: item.id,
						label: i18n._(item.label),
					}))}
					value={providerId}
					onChange={(value) => {
						if (!value) return;
						setProviderId(value);
						setConfig({});
					}}
					disabled={!!connection}
					allowDeselect={false}
					description={provider ? i18n._(provider.description) : undefined}
				/>
				<TextInput
					label={i18n._("Name")}
					value={name}
					onChange={(event) => setName(event.currentTarget.value)}
					required
				/>
				<SchemaFormFields
					fields={fields}
					values={config}
					onChange={setField}
					editing={!!connection}
					errors={issues.issues}
				/>
				{save.fieldError() && (
					<Text size="sm" c="red">
						{save.fieldError()}
					</Text>
				)}
				<Text size="xs" c="dimmed">
					{i18n._(
						"Credentials are encrypted, only used to reach the project from the panel and from the server that runs a sync, and never shown again.",
					)}
				</Text>
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{i18n._("Cancel")}
					</Button>
					<Button
						loading={save.isPending}
						disabled={!name.trim() || !provider}
						onClick={submit}
					>
						{i18n._("Save")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
};
