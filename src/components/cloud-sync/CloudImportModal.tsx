import { useLingui } from "@lingui/react";
import {
	Alert,
	Anchor,
	Button,
	Checkbox,
	Group,
	Modal,
	Select,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useFreeDomainProvider } from "#/components/apps/useFreeDomainProvider";
import {
	liveServerStatus,
	useUnreachableServers,
} from "#/components/monitoring/ServerLiveStatus";
import { SchemaFormFields } from "#/components/ui/SchemaFormFields";
import { useAppMutation } from "#/components/ui/useAppMutation";
import {
	type CloudSyncProvider,
	importFields,
	partsFor,
	type SyncPart,
	syncPartLabel,
} from "#/config/cloud-sync.ts";
import { EXAMPLES } from "#/config/shared.ts";
import {
	previewCloudImportFn,
	startCloudImportFn,
} from "#/features/cloud-sync/cloud-sync.functions.ts";
import { cloudConnectionsQueryOptions } from "#/features/cloud-sync/cloud-sync.query.ts";
import type { CloudPreflight } from "#/features/cloud-sync/schema.ts";
import { serversQueryOptions } from "#/features/servers/servers.query.ts";
import { templateVersionsQueryOptions } from "#/features/templates/templates.query.ts";
import { LocalizedLink, localizePath } from "#/libs/i18n";
import { CloudPreflightView } from "./CloudPreflightView";

/**
 * Import a cloud project into a NEW app: pick a connection, a server and
 * the parts, check (preflight: sizes, versions, disk, warnings), confirm.
 */
export const CloudImportModal: React.FC<{
	provider: CloudSyncProvider;
	opened: boolean;
	onClose: () => void;
}> = ({ provider, opened, onClose }) => {
	const { i18n } = useLingui();
	const navigate = useNavigate();
	const freeDomainProvider = useFreeDomainProvider();
	const { data: connections = [] } = useQuery({
		...cloudConnectionsQueryOptions,
		enabled: opened,
	});
	const { data: servers = [] } = useQuery(serversQueryOptions);
	const unreachable = useUnreachableServers();
	const ready = servers.filter(
		(server) => liveServerStatus(server, unreachable) === "ready",
	);
	const ownConnections = connections.filter(
		(connection) => connection.provider === provider.id,
	);
	const available = partsFor(provider, "import");
	const [connectionId, setConnectionId] = useState<string | null>(null);
	const [serverId, setServerId] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [domain, setDomain] = useState("");
	const [parts, setParts] = useState<SyncPart[]>(available);
	const [version, setVersion] = useState<string | null>(null);
	const [inputs, setInputs] = useState<Record<string, unknown>>({});
	const [preflight, setPreflight] = useState<CloudPreflight | null>(null);
	const fields = importFields(provider);
	const versions = useQuery({
		...templateVersionsQueryOptions(provider.templateId),
		enabled: opened,
	});
	useEffect(() => {
		if (!opened) return;
		setPreflight(null);
		setVersion(null);
		setInputs({});
		setParts(partsFor(provider, "import"));
	}, [opened, provider]);
	// Any change makes the last check stale.
	const change =
		<T,>(set: (value: T) => void) =>
		(value: T) => {
			set(value);
			setPreflight(null);
		};

	const check = useAppMutation({
		mutationFn: async () =>
			await previewCloudImportFn({
				data: {
					connectionId: connectionId ?? "",
					serverId: serverId ?? "",
					parts,
					version: version ?? undefined,
					inputs,
				},
			}),
		field: "import",
		onSuccess: (result) => {
			setPreflight(result);
			if (!name.trim()) setName(result.project.name);
		},
	});
	const start = useAppMutation({
		mutationFn: async () =>
			await startCloudImportFn({
				data: {
					connectionId: connectionId ?? "",
					serverId: serverId ?? "",
					parts,
					version: version ?? undefined,
					inputs,
					name,
					domain: domain || undefined,
				},
			}),
		field: "import",
		onSuccess: ({ appId, deploymentId }) => {
			onClose();
			navigate({
				to: localizePath(`/apps/${appId}`) as never,
				search: { tab: "deployments", job: deploymentId } as never,
			});
		},
	});
	const partLabel = (part: SyncPart) => {
		const label = syncPartLabel(provider, part);
		return label ? i18n._(label) : part;
	};
	const error = check.fieldError() ?? start.fieldError();
	const canCheck = !!connectionId && !!serverId && parts.length > 0;
	const blocked = !!preflight && preflight.blockers.length > 0;

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={i18n._(provider.importLabel)}
			size="lg"
			centered
		>
			<Stack>
				<Text size="sm" c="dimmed">
					{i18n._(
						"Creates a new app from the cloud project's copy. The cloud project is only read, never changed.",
					)}
				</Text>
				{ownConnections.length === 0 ? (
					<Alert color="blue">
						{i18n._("Add a connection to the project first.")}{" "}
						<Anchor component={LocalizedLink} to="/settings/cloud-connections">
							{i18n._("Cloud connections")}
						</Anchor>
					</Alert>
				) : (
					<Select
						label={i18n._("Connection")}
						data={ownConnections.map((connection) => ({
							value: connection.id,
							label: connection.name,
						}))}
						value={connectionId}
						onChange={change(setConnectionId)}
						allowDeselect={false}
					/>
				)}
				<Select
					label={i18n._("Server")}
					data={ready.map((server) => ({
						value: server.id,
						label: `${server.name} (${server.host})`,
					}))}
					value={serverId}
					onChange={change(setServerId)}
					allowDeselect={false}
				/>
				<Checkbox.Group
					label={i18n._("Copy")}
					value={parts}
					onChange={(value) => change(setParts)(value as SyncPart[])}
				>
					<Group mt={4}>
						{available.map((part) => (
							<Checkbox key={part} value={part} label={partLabel(part)} />
						))}
					</Group>
				</Checkbox.Group>
				<SchemaFormFields
					fields={fields}
					values={inputs}
					onChange={(name, value) => {
						setInputs((prev) => ({ ...prev, [name]: value }));
						setPreflight(null);
					}}
				/>
				<Select
					label={i18n._("Release of the new app")}
					description={i18n._(
						"Not older than the cloud project's version (the check refuses older ones).",
					)}
					placeholder={
						versions.data?.defaultRef
							? i18n._("Latest stable ({version})", {
									version: versions.data.defaultRef,
								})
							: i18n._("Latest stable")
					}
					data={(versions.data?.versions ?? []).map((item) => ({
						value: item.ref,
						label: item.name,
					}))}
					value={version}
					onChange={change(setVersion)}
					searchable
					clearable
				/>
				<TextInput
					label={i18n._("App name")}
					value={name}
					onChange={(event) => setName(event.currentTarget.value)}
				/>
				<TextInput
					label={i18n._("Domain")}
					placeholder={EXAMPLES.appHost}
					description={i18n._("Leave empty for a free {provider} domain.", {
						provider: freeDomainProvider,
					})}
					value={domain}
					onChange={(event) => setDomain(event.currentTarget.value)}
				/>
				{preflight && (
					<CloudPreflightView provider={provider} preflight={preflight} />
				)}
				{error && (
					<Text size="sm" c="red">
						{error}
					</Text>
				)}
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{i18n._("Cancel")}
					</Button>
					{!preflight ? (
						<Button
							disabled={!canCheck}
							loading={check.isPending}
							onClick={() => check.mutate()}
						>
							{i18n._("Check")}
						</Button>
					) : (
						<Button
							disabled={blocked || !name.trim()}
							loading={start.isPending}
							onClick={() => start.mutate()}
						>
							{i18n._("Import into a new app")}
						</Button>
					)}
				</Group>
			</Stack>
		</Modal>
	);
};
