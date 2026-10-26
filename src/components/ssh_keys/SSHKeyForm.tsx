import { useLingui } from "@lingui/react";
import {
	Alert,
	Button,
	Checkbox,
	Group,
	SegmentedControl,
	Select,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { schemaResolver, type UseFormReturnType, useForm } from "@mantine/form";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, KeyRound } from "lucide-react";
import { useState } from "react";
import {
	DEFAULT_SSH_KEY_TYPE,
	SSH_KEY_TYPES,
	sshKeyTypes,
} from "#/config/ssh-key-types.ts";
import type {
	GenerateSSHKeyInput,
	SSHKeyDTO,
	SSHKeyInput,
	SSHKeyUpdatePayload,
} from "#/features/ssh_keys/schema.ts";
import {
	AddSSHKeySchema,
	EditSSHKeyFormSchema,
	GenerateSSHKeySchema,
} from "#/features/ssh_keys/schema.ts";
import { generateSSHKeyFn } from "#/features/ssh_keys/ssh_keygen.functions.ts";
import {
	addSSHKeyFn,
	revealSSHKeyFn,
	updateSSHKeyFn,
} from "#/features/ssh_keys/ssh_keys.functions.ts";
import { sshKeysQueryOptions } from "#/features/ssh_keys/ssh_keys.query.ts";
import { CopyField } from "../ui/CopyField";
import { CopyIconButton } from "../ui/CopyIconButton";
import { SecretInput } from "../ui/SecretInput";
import { useAppMutation } from "../ui/useAppMutation";

type SSHKeyFormProps = {
	data?: SSHKeyDTO;
	onClose?: () => void;
};

type AddMode = "generate" | "import";

/**
 * Create/edit form for an SSH key. Without `data` it either generates a key
 * pair on the server (stored right away; only the public key comes back)
 * or imports an existing private key. With `data` it edits that key and
 * sends only the fields that changed; the private key is never prefilled
 * and is only shown through the audited reveal.
 */
export const SSHKeyForm: React.FC<SSHKeyFormProps> = ({ data, onClose }) => {
	const { i18n } = useLingui();
	const [mode, setMode] = useState<AddMode>("generate");
	const [generated, setGenerated] = useState<SSHKeyDTO | null>(null);

	if (data) return <EditSSHKeyForm data={data} onClose={onClose} />;
	if (generated) {
		return <GeneratedKeyResult sshKey={generated} onClose={onClose} />;
	}
	return (
		<Stack gap="md">
			<SegmentedControl
				fullWidth
				value={mode}
				onChange={(value) => setMode(value as AddMode)}
				data={[
					{ value: "generate", label: i18n._("Generate on server") },
					{ value: "import", label: i18n._("Import existing key") },
				]}
			/>
			{mode === "generate" ? (
				<GenerateSSHKeyForm onCreated={setGenerated} onClose={onClose} />
			) : (
				<ImportSSHKeyForm onClose={onClose} />
			)}
		</Stack>
	);
};

function useInvalidateKeys() {
	const queryClient = useQueryClient();
	return () =>
		queryClient.invalidateQueries({ queryKey: sshKeysQueryOptions.queryKey });
}

const FormActions: React.FC<{
	onClose?: () => void;
	pending: boolean;
	submitLabel: string;
}> = ({ onClose, pending, submitLabel }) => {
	const { i18n } = useLingui();
	return (
		<Group mt="xl" justify="space-between">
			<Button variant="default" onClick={onClose}>
				{i18n._("Cancel")}
			</Button>
			<Button type="submit" loading={pending}>
				{submitLabel}
			</Button>
		</Group>
	);
};

type InputProps = ReturnType<
	UseFormReturnType<{ name: string }>["getInputProps"]
>;

/**
 * Name + description inputs shared by the generate, import and edit forms.
 * `autoComplete="off"`: next to the passphrase, browsers otherwise take
 * them for the user name of a saved sign-in (BUG-001).
 */
const NameFields: React.FC<{ name: InputProps; description: InputProps }> = ({
	name,
	description,
}) => {
	const { i18n } = useLingui();
	return (
		<>
			<TextInput
				label={i18n._("Key name")}
				placeholder={i18n._("e.g., Personal Laptop, Hetzner Production")}
				description={i18n._("A friendly label to identify this key")}
				autoComplete="off"
				{...name}
			/>
			<TextInput
				label={i18n._("Description")}
				placeholder={i18n._("Optional notes about this key")}
				autoComplete="off"
				{...description}
			/>
		</>
	);
};

/** Server-side generation: the private key never reaches the browser. */
const GenerateSSHKeyForm: React.FC<{
	onCreated: (key: SSHKeyDTO) => void;
	onClose?: () => void;
}> = ({ onCreated, onClose }) => {
	const { i18n } = useLingui();
	const invalidate = useInvalidateKeys();
	const form = useForm<GenerateSSHKeyInput>({
		mode: "controlled",
		initialValues: { name: "", description: "", keyType: DEFAULT_SSH_KEY_TYPE },
		validate: schemaResolver(GenerateSSHKeySchema(i18n), { sync: true }),
	});
	const generate = useAppMutation({
		mutationFn: (values: GenerateSSHKeyInput) =>
			generateSSHKeyFn({ data: values }),
		form,
		success: i18n._("SSH key generated successfully."),
		onSuccess: async (key) => {
			await invalidate();
			onCreated(key);
		},
	});
	return (
		<form onSubmit={form.onSubmit((values) => generate.mutate(values))}>
			<Stack gap="md">
				<NameFields
					name={form.getInputProps("name")}
					description={form.getInputProps("description")}
				/>
				<Select
					label={i18n._("Key type")}
					allowDeselect={false}
					// Recommended type first.
					data={[...SSH_KEY_TYPES]
						.sort(
							(a, b) =>
								Number(b === DEFAULT_SSH_KEY_TYPE) -
								Number(a === DEFAULT_SSH_KEY_TYPE),
						)
						.map((type) => ({ value: type, label: sshKeyTypes[type].label }))}
					{...form.getInputProps("keyType")}
				/>
				<Text size="xs" c="dimmed">
					{i18n._(
						"The key pair is generated and stored encrypted on the server. Only the public key is shown; reveal the private key later if you need it.",
					)}
				</Text>
			</Stack>
			<FormActions
				onClose={onClose}
				pending={generate.isPending}
				submitLabel={i18n._("Generate key")}
			/>
		</form>
	);
};

/** After generation: the public key to install on servers. */
const GeneratedKeyResult: React.FC<{
	sshKey: SSHKeyDTO;
	onClose?: () => void;
}> = ({ sshKey, onClose }) => {
	const { i18n } = useLingui();
	return (
		<Stack gap="md">
			<Alert color="green" variant="light" icon={<KeyRound size={16} />}>
				{i18n._(
					"{name} is stored. Add its public key to ~/.ssh/authorized_keys on your servers, or pick it when adding a server.",
					{ name: sshKey.name },
				)}
			</Alert>
			<Text size="sm" fw={500}>
				{i18n._("Public Key")}
			</Text>
			<CopyField value={sshKey.publicKey} block />
			<Group justify="flex-end">
				<Button onClick={onClose}>{i18n._("Done")}</Button>
			</Group>
		</Stack>
	);
};

const importInitialValues: SSHKeyInput = {
	name: "",
	description: "",
	privateKey: "",
	publicKey: "",
	passphrase: "",
};

/** Import an existing private key (type and fingerprint derive from it). */
const ImportSSHKeyForm: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
	const { i18n } = useLingui();
	const invalidate = useInvalidateKeys();
	const form = useForm<SSHKeyInput>({
		mode: "controlled",
		initialValues: importInitialValues,
		validate: schemaResolver(AddSSHKeySchema(i18n), { sync: true }),
	});
	const add = useAppMutation({
		// Empty passphrase means "unencrypted key", so send undefined.
		mutationFn: (values: SSHKeyInput) =>
			addSSHKeyFn({
				data: { ...values, passphrase: values.passphrase || undefined },
			}),
		form,
		// Key refusals (invalid, passphrase, mismatch) show under the key.
		field: "privateKey",
		success: i18n._("SSH key added successfully."),
		onSuccess: async () => {
			await invalidate();
			onClose?.();
		},
	});
	return (
		<form onSubmit={form.onSubmit((values) => add.mutate(values))}>
			<Stack gap="md">
				<NameFields
					name={form.getInputProps("name")}
					description={form.getInputProps("description")}
				/>
				<KeyMaterialFields
					form={form}
					editing={false}
					keyError={add.fieldError()}
					onKeyChange={add.clearFieldError}
				/>
			</Stack>
			<FormActions
				onClose={onClose}
				pending={add.isPending}
				submitLabel={i18n._("Add SSH Key")}
			/>
		</form>
	);
};

const KeyMaterialFields: React.FC<{
	form: Pick<UseFormReturnType<SSHKeyInput>, "getInputProps" | "values">;
	editing: boolean;
	/** Server refusal of the key material (shown under the private key). */
	keyError?: string;
	onKeyChange?: () => void;
	/**
	 * Passphrase input (edit form: only for an encrypted key or a newly
	 * pasted one). `keep`: a passphrase is stored and blank keeps it.
	 */
	passphrase?: {
		keep: boolean;
		disabled?: boolean;
		extra?: React.ReactNode;
	} | null;
}> = ({
	form,
	editing,
	keyError,
	onKeyChange,
	passphrase = { keep: false },
}) => {
	const privateKeyProps = form.getInputProps("privateKey");
	const { i18n } = useLingui();
	return (
		<>
			<Textarea
				label={i18n._("Private key")}
				description={
					editing
						? i18n._(
								"Leave unchanged to keep the current key, or reveal to edit.",
							)
						: i18n._(
								"Your private key will be encrypted at rest using AES-256-GCM",
							)
				}
				placeholder={i18n._(
					"Enter your private key, example: -----BEGIN OPENSSH PRIVATE KEY----- ... -----END OPENSSH PRIVATE KEY-----",
				)}
				minRows={4}
				autosize
				{...privateKeyProps}
				error={privateKeyProps.error ?? keyError}
				onChange={(event) => {
					onKeyChange?.();
					privateKeyProps.onChange(event);
				}}
				rightSection={
					<CopyIconButton
						value={form.values.privateKey}
						label={i18n._("Copy private key")}
					/>
				}
			/>
			{passphrase && (
				<Stack gap="xs">
					<SecretInput
						label={i18n._("Passphrase")}
						description={
							passphrase.keep
								? i18n._(
										"Only for encrypted keys. Leave empty to keep the current passphrase.",
									)
								: i18n._("Only for encrypted keys. Stored encrypted at rest.")
						}
						disabled={passphrase.disabled}
						{...form.getInputProps("passphrase")}
					/>
					{passphrase.extra}
				</Stack>
			)}
			<Textarea
				label={i18n._("Public Key")}
				placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5... user@host"
				description={i18n._(
					"Optional: derived from the private key when empty, and must match it otherwise",
				)}
				minRows={3}
				autosize
				{...form.getInputProps("publicKey")}
				rightSection={
					<CopyIconButton
						value={form.values.publicKey ?? ""}
						label={i18n._("Copy public key")}
					/>
				}
			/>
		</>
	);
};

/** Edit an existing key; only changed fields are sent. */
const EditSSHKeyForm: React.FC<{ data: SSHKeyDTO; onClose?: () => void }> = ({
	data,
	onClose,
}) => {
	const { i18n } = useLingui();
	const invalidate = useInvalidateKeys();
	const form = useForm<SSHKeyInput>({
		mode: "controlled",
		initialValues: {
			name: data.name,
			description: data.description ?? "",
			privateKey: "",
			publicKey: data.publicKey,
			// Secrets are write-only: blank means "keep the stored value".
			passphrase: "",
		},
		// Empty private key = keep the stored one; `id` is not a form field.
		validate: schemaResolver(EditSSHKeyFormSchema(i18n), { sync: true }),
	});

	// The revealed key, to tell it apart from a newly pasted one.
	const [revealed, setRevealed] = useState<string | null>(null);
	const [clearPassphrase, setClearPassphrase] = useState(false);
	// Audited server action; the key fills the field for viewing or editing.
	const reveal = useAppMutation({
		mutationFn: () => revealSSHKeyFn({ data: data.id }),
		onSuccess: (privateKey) => {
			setRevealed(privateKey);
			form.setFieldValue("privateKey", privateKey);
		},
	});
	const typedKey = form.values.privateKey.trim();
	const newKey = !!typedKey && typedKey !== revealed?.trim();
	// Unencrypted keys have no passphrase: no field a browser could fill.
	const showPassphrase = data.hasPassphrase || newKey;

	const save = useAppMutation({
		mutationFn: (values: SSHKeyInput) => {
			// Partial update: empty secret fields are omitted so the stored
			// encrypted values are kept.
			const payload: SSHKeyUpdatePayload = { id: data.id };
			if (values.name !== data.name) payload.name = values.name;
			if (values.description !== (data.description ?? "")) {
				payload.description = values.description;
			}
			if (newKey) payload.privateKey = values.privateKey;
			if (data.hasPassphrase && clearPassphrase) payload.clearPassphrase = true;
			else if (showPassphrase && values.passphrase) {
				payload.passphrase = values.passphrase;
			}
			if (values.publicKey !== data.publicKey) {
				payload.publicKey = values.publicKey;
			}
			return updateSSHKeyFn({ data: payload });
		},
		form,
		field: "privateKey",
		success: i18n._("SSH key updated successfully."),
		onSuccess: async () => {
			await invalidate();
			onClose?.();
		},
	});

	return (
		<form onSubmit={form.onSubmit((values) => save.mutate(values))}>
			<Stack gap="md">
				<NameFields
					name={form.getInputProps("name")}
					description={form.getInputProps("description")}
				/>
				<Group>
					<Button
						variant="light"
						size="xs"
						leftSection={<Eye size={16} />}
						loading={reveal.isPending}
						onClick={() => reveal.mutate()}
					>
						{i18n._("Reveal private key")}
					</Button>
				</Group>
				<KeyMaterialFields
					form={form}
					editing
					keyError={save.fieldError()}
					onKeyChange={save.clearFieldError}
					passphrase={
						showPassphrase
							? {
									keep: data.hasPassphrase && !clearPassphrase && !newKey,
									disabled: data.hasPassphrase && clearPassphrase,
									extra: data.hasPassphrase && (
										<Checkbox
											label={i18n._(
												"Remove the stored passphrase (the key is not encrypted)",
											)}
											checked={clearPassphrase}
											onChange={(event) =>
												setClearPassphrase(event.currentTarget.checked)
											}
										/>
									),
								}
							: null
					}
				/>
			</Stack>
			<FormActions
				onClose={onClose}
				pending={save.isPending}
				submitLabel={i18n._("Save Changes")}
			/>
		</form>
	);
};
