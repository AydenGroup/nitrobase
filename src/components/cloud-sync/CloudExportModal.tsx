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
import { useEffect, useState } from "react";
import { ErrorText } from "#/components/ui/ErrorText";
import { SchemaFormFields } from "#/components/ui/SchemaFormFields";
import { useAppMutation } from "#/components/ui/useAppMutation";
import {
	type CloudSyncProvider,
	directionCapability,
	exportFields,
	partsFor,
	type SyncPart,
	syncPartLabel,
} from "#/config/cloud-sync.ts";
import {
	cloudExportOptionsFn,
	previewCloudExportFn,
	startCloudExportFn,
} from "#/features/cloud-sync/cloud-sync.functions.ts";
import { cloudConnectionsQueryOptions } from "#/features/cloud-sync/cloud-sync.query.ts";
import type { CloudPreflight } from "#/features/cloud-sync/schema.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import { LocalizedLink } from "#/libs/i18n";
import { CloudPreflightView } from "./CloudPreflightView";

/**
 * Export an app into an EMPTY cloud project: pick a connection and the
 * parts, check (the project must be empty; sizes, versions, warnings),
 * type the project's ID to confirm, then follow the job.
 */
export const CloudExportModal: React.FC<{
	provider: CloudSyncProvider;
	appId: string;
	opened: boolean;
	onClose: () => void;
	onStarted: (deploymentId: string) => void;
}> = ({ provider, appId, opened, onClose, onStarted }) => {
	const { i18n } = useLingui();
	const { data: connections = [] } = useQuery({
		...cloudConnectionsQueryOptions,
		enabled: opened,
	});
	const own = connections.filter(
		(connection) => connection.provider === provider.id,
	);
	const available = partsFor(provider, "export");
	const [connectionId, setConnectionId] = useState<string | null>(null);
	const [parts, setParts] = useState<SyncPart[]>(available);
	const [inputs, setInputs] = useState<Record<string, unknown>>({});
	const [preflight, setPreflight] = useState<CloudPreflight | null>(null);
	const [confirm, setConfirm] = useState("");
	useEffect(() => {
		if (!opened) return;
		setPreflight(null);
		setConfirm("");
		setInputs({});
		setParts(partsFor(provider, "export"));
	}, [opened, provider]);
	const stale = () => {
		setPreflight(null);
		setConfirm("");
	};
	const options = useQuery({
		queryKey: ["apps", appId, "cloud-export-options", connectionId],
		queryFn: async () =>
			await cloudExportOptionsFn({
				data: { appId, connectionId: connectionId ?? "", inputs: {} },
			}),
		enabled: opened && !!connectionId,
		retry: false,
	});
	const connection = own.find((item) => item.id === connectionId);
	const capability = directionCapability(
		connection?.lastTest ?? null,
		"export",
	);
	const projectField = options.data?.projectField;
	const hidden = new Set([
		...(options.data?.hidden ?? []),
		...(options.data?.projects && projectField ? [projectField] : []),
	]);
	const fields = exportFields(provider).filter(
		(field) => !hidden.has(field.name),
	);

	const check = useAppMutation({
		mutationFn: async () =>
			await previewCloudExportFn({
				data: { appId, connectionId: connectionId ?? "", parts, inputs },
			}),
		field: "export",
		onSuccess: (result) => setPreflight(result),
	});
	const start = useAppMutation({
		mutationFn: async () =>
			await startCloudExportFn({
				data: {
					appId,
					connectionId: connectionId ?? "",
					parts,
					inputs,
					confirm,
				},
			}),
		field: "export",
		onSuccess: ({ deploymentId }) => {
			onClose();
			onStarted(deploymentId);
		},
	});
	const partLabel = (part: SyncPart) => {
		const label = syncPartLabel(provider, part);
		return label ? i18n._(label) : part;
	};
	const error = check.fieldError() ?? start.fieldError();
	const blocked = !!preflight && preflight.blockers.length > 0;
	const confirmed = !!preflight && confirm.trim() === preflight.project.id;

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={i18n._(provider.exportLabel)}
			size="lg"
			centered
		>
			<Stack>
				<Text size="sm" c="dimmed">
					{i18n._(
						"Copies this app into an empty cloud project. The app keeps running and is only read; a project that already holds data is refused.",
					)}
				</Text>
				{own.length === 0 ? (
					<Alert color="blue">
						{i18n._("Add a connection to the project first.")}{" "}
						<Anchor component={LocalizedLink} to="/settings/cloud-connections">
							{i18n._("Cloud connections")}
						</Anchor>
					</Alert>
				) : (
					<Select
						label={i18n._("Connection")}
						data={own.map((item) => ({ value: item.id, label: item.name }))}
						value={connectionId}
						onChange={(value) => {
							setConnectionId(value);
							setInputs({});
							stale();
						}}
						allowDeselect={false}
					/>
				)}
				{capability && !capability.ok && (
					<Alert
						color="red"
						title={i18n._("The last test says this connection cannot export")}
					>
						{capability.reason ? (
							<ErrorText error={capability.reason as ErrorInfo} size="sm" />
						) : null}
					</Alert>
				)}
				{options.error && (
					<Alert color="red">
						<Text size="sm">{options.error.message}</Text>
					</Alert>
				)}
				<Checkbox.Group
					label={i18n._("Copy")}
					value={parts}
					onChange={(value) => {
						setParts(value as SyncPart[]);
						stale();
					}}
				>
					<Group mt={4}>
						{available.map((part) => (
							<Checkbox key={part} value={part} label={partLabel(part)} />
						))}
					</Group>
				</Checkbox.Group>
				{options.data?.projects && projectField && (
					<Select
						label={i18n._("Project of this app")}
						data={options.data.projects.map((project) => ({
							value: project.id,
							label: project.name
								? `${project.name} (${project.id})`
								: project.id,
						}))}
						value={(inputs[projectField] as string | undefined) ?? null}
						onChange={(value) => {
							setInputs((prev) => ({ ...prev, [projectField]: value ?? "" }));
							stale();
						}}
						allowDeselect={false}
					/>
				)}
				{connectionId && (
					<SchemaFormFields
						fields={fields}
						values={inputs}
						onChange={(name, value) => {
							setInputs((prev) => ({ ...prev, [name]: value }));
							stale();
						}}
					/>
				)}
				{preflight && (
					<CloudPreflightView provider={provider} preflight={preflight} />
				)}
				{preflight && !blocked && (
					<TextInput
						label={i18n._("Type {project} to confirm", {
							project: preflight.project.id,
						})}
						description={i18n._(
							"The export writes into this cloud project. It must stay empty until the export ends.",
						)}
						value={confirm}
						onChange={(event) => setConfirm(event.currentTarget.value)}
						autoComplete="off"
						data-autofocus
					/>
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
							disabled={!connectionId || parts.length === 0}
							loading={check.isPending}
							onClick={() => check.mutate()}
						>
							{i18n._("Check")}
						</Button>
					) : (
						<Button
							color="red"
							disabled={blocked || !confirmed}
							loading={start.isPending}
							onClick={() => start.mutate()}
						>
							{i18n._("Export")}
						</Button>
					)}
				</Group>
			</Stack>
		</Modal>
	);
};
