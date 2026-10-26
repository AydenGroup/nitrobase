import { useLingui } from "@lingui/react";
import {
	Alert,
	Anchor,
	Button,
	Divider,
	Group,
	NumberInput,
	Radio,
	Select,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CircleCheck, CircleX } from "lucide-react";
import { useState } from "react";
import { ErrorText } from "#/components/ui/ErrorText.tsx";
import { SecretInput } from "#/components/ui/SecretInput.tsx";
import {
	DEFAULT_SERVER_AUTH_METHOD,
	serverAuthMethods,
} from "#/config/server-auth-methods.ts";
import { DEFAULT_SSH_PORT, DEFAULT_SSH_USERNAME } from "#/config/shared.ts";
import { sshKeyTypes } from "#/config/ssh-key-types.ts";
import type { ServerDTO, ServerInput } from "#/features/servers/schema.ts";
import {
	AddServerSchema,
	UpdateServerSchema,
} from "#/features/servers/schema.ts";
import {
	addServerFn,
	testServerCredentialsFn,
	updateServerFn,
} from "#/features/servers/servers.functions.ts";
import { serversQueryOptions } from "#/features/servers/servers.query.ts";
import { sshKeysQueryOptions } from "#/features/ssh_keys/ssh_keys.query.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import { LocalizedLink } from "#/libs/i18n.ts";
import { useAppMutation } from "../ui/useAppMutation";

const initialValues: ServerInput = {
	name: "",
	host: "",
	port: DEFAULT_SSH_PORT,
	username: DEFAULT_SSH_USERNAME,
	authMethod: DEFAULT_SERVER_AUTH_METHOD,
	sshKeyId: undefined,
	password: "",
};

type ServerFormProps = {
	data?: ServerDTO;
	onClose?: () => void;
};

/**
 * Add/edit form for a managed server (SSH target). Without `data` it creates
 * a server and navigates to its detail page; with `data` it updates it in
 * place. The stored password is never sent back, so it starts blank.
 */
export const ServerForm: React.FC<ServerFormProps> = ({ data, onClose }) => {
	const { i18n } = useLingui();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const isEditMode = Boolean(data);
	const { data: savedSSHKeys = [] } = useQuery(sshKeysQueryOptions);

	// Shown inline under the buttons; cleared when a field changes.
	const [testResult, setTestResult] = useState<{
		success: boolean;
		error?: ErrorInfo;
	} | null>(null);
	// Controlled: the credential fields follow the chosen auth method.
	const form = useForm<ServerInput>({
		mode: "controlled",
		onValuesChange: () => setTestResult(null),
		// In edit mode the whole DTO (including `id`) is spread in, which is
		// what the update call relies on. A null key id becomes undefined so
		// the Select shows its placeholder.
		initialValues: {
			...initialValues,
			...data,
			sshKeyId: data?.sshKeyId ?? undefined,
		},
		validate: schemaResolver(
			isEditMode ? UpdateServerSchema(i18n) : AddServerSchema(i18n),
			{ sync: true },
		),
	});

	const { mutate: mutateServer, isPending } = useAppMutation({
		mutationFn: async (values: ServerInput) =>
			isEditMode
				? await updateServerFn({ data: values })
				: await addServerFn({ data: values }),
		form,
		success: isEditMode
			? i18n._("Server updated successfully.")
			: i18n._("Server added successfully."),
		onSuccess: async (server) => {
			await queryClient.invalidateQueries({
				queryKey: serversQueryOptions.queryKey,
			});
			onClose?.();
			if (!isEditMode) {
				await navigate({
					to: "/{-$locale}/servers/$serverId",
					params: (prev) => ({ ...prev, serverId: server.id }),
				});
			}
		},
	});

	const { mutate: testCredentials, isPending: isTesting } = useAppMutation({
		mutationFn: async (values: ServerInput) =>
			await testServerCredentialsFn({
				data: {
					...values,
					id: data?.id,
					password: values.password || undefined,
				},
			}),
		form,
		onMutate: () => setTestResult(null),
		onSuccess: async (result) => {
			setTestResult(result);
			// The stored server's status follows the test (edit mode).
			if (isEditMode) {
				await queryClient.invalidateQueries({
					queryKey: serversQueryOptions.queryKey,
				});
			}
		},
	});

	const authMethod = form.values.authMethod;
	const authNote = serverAuthMethods.find(
		(method) => method.value === authMethod,
	)?.note;

	return (
		<form onSubmit={form.onSubmit((values) => mutateServer(values))}>
			<Stack gap="md">
				<TextInput
					label={i18n._("Server name")}
					placeholder={i18n._("Production Server")}
					description={i18n._("A friendly name to identify this server")}
					autoComplete="off"
					{...form.getInputProps("name")}
				/>
				<Group grow align="flex-start" wrap="wrap">
					<TextInput
						label={i18n._("Host")}
						placeholder="192.168.1.100"
						description={i18n._("IP address or domain name")}
						autoComplete="off"
						{...form.getInputProps("host")}
					/>
					<NumberInput
						label={i18n._("Port")}
						description={i18n._("SSH port, usually {port}", {
							port: DEFAULT_SSH_PORT,
						})}
						placeholder={String(DEFAULT_SSH_PORT)}
						min={1}
						max={65535}
						{...form.getInputProps("port")}
					/>
				</Group>
				<TextInput
					label={i18n._("Username")}
					placeholder={DEFAULT_SSH_USERNAME}
					description={i18n._("SSH user with sudo access")}
					// Not the panel's sign-in: keep the browser from filling it.
					autoComplete="off"
					{...form.getInputProps("username")}
				/>
				<Divider label={i18n._("Authentication")} labelPosition="center" />
				<Radio.Group
					label={i18n._("Authentication method")}
					description={i18n._("SSH key is recommended for security")}
					{...form.getInputProps("authMethod")}
				>
					<Group mt="xs">
						{serverAuthMethods.map((method) => (
							<Radio
								key={method.value}
								value={method.value}
								label={i18n._(method.label)}
							/>
						))}
					</Group>
				</Radio.Group>
				{authMethod === "private_key" ? (
					savedSSHKeys.length > 0 ? (
						<Select
							label={i18n._("SSH key")}
							placeholder={i18n._("Select an SSH key")}
							description={i18n._(
								"The private key used to authenticate with the server",
							)}
							data={savedSSHKeys.map((k) => ({
								value: k.id,
								label: `${k.name} (${sshKeyTypes[k.keyType]?.label ?? k.keyType})`,
							}))}
							{...form.getInputProps("sshKeyId")}
						/>
					) : (
						<Stack gap="xs">
							<Text size="sm" c="dimmed">
								{i18n._("No saved SSH keys found.")}
							</Text>
							<Anchor
								component={LocalizedLink}
								to="/ssh-keys"
								size="sm"
								onClick={onClose}
							>
								{i18n._("Add an SSH key first")} →
							</Anchor>
						</Stack>
					)
				) : (
					<SecretInput
						label={i18n._("Password")}
						placeholder={i18n._("Server password")}
						description={i18n._(
							"Password will be used for initial setup only. SSH key will be installed automatically.",
						)}
						{...form.getInputProps("password")}
					/>
				)}
				{authNote && (
					<Text c="dimmed" size="xs">
						{i18n._(authNote)}
					</Text>
				)}
				{testResult && (
					<Alert
						color={testResult.success ? "green" : "red"}
						variant="light"
						icon={
							testResult.success ? (
								<CircleCheck size={16} />
							) : (
								<CircleX size={16} />
							)
						}
						title={
							testResult.success
								? i18n._("Connection succeeded")
								: i18n._("Connection failed")
						}
					>
						{testResult.success ? (
							<Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
								{isEditMode
									? i18n._("The server is reachable.")
									: i18n._(
											"The server is reachable. Add it, then bootstrap it to install Docker and Traefik.",
										)}
							</Text>
						) : (
							<ErrorText error={testResult.error} />
						)}
					</Alert>
				)}
				<Group mt="xl" m={5} justify="space-between">
					<Button
						variant="outline"
						loading={isTesting}
						disabled={isPending}
						onClick={() => testCredentials(form.values)}
					>
						{i18n._("Test connection")}
					</Button>
					<Button type="submit" loading={isPending}>
						{isEditMode ? i18n._("Update server") : i18n._("Add server")}
					</Button>
				</Group>
			</Stack>
		</form>
	);
};
