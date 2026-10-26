import { useLingui } from "@lingui/react";
import {
	Alert,
	Button,
	FileInput,
	List,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackup } from "lucide-react";
import { useState } from "react";
import { SecretInput } from "#/components/ui/SecretInput.tsx";
import { SELF_BACKUP_EXAMPLE } from "#/config/self-backup.ts";
import { APP_NAME } from "#/config/shared.ts";
import type { FirstRunRestoreResult } from "#/features/setup/schema.ts";
import { LocalizedLink } from "#/libs/i18n.ts";
import { formatDate } from "#/libs/intl.ts";

/**
 * First run: restore Nitrobase from a self-backup instead of creating the
 * administrator (disaster recovery on a new machine). The server checks
 * the sha256, decrypts with the old ENCRYPTION_KEY and pauses the
 * restored installation until an instance admin resumes it.
 */
export const RestoreSelfBackupForm: React.FC<{ tokenRequired: boolean }> = ({
	tokenRequired,
}) => {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const [file, setFile] = useState<File | null>(null);
	const [key, setKey] = useState("");
	const [sha256, setSha256] = useState("");
	const [setupToken, setSetupToken] = useState("");
	const restore = useMutation({
		mutationFn: async (): Promise<FirstRunRestoreResult> => {
			if (!file) throw new Error(i18n._("Choose the .tar.gz.enc file"));
			// The file is the body (streamed to disk on the server); the
			// rest travels in headers (the key base64-encoded).
			const bytes = new TextEncoder().encode(key);
			let binary = "";
			for (const byte of bytes) binary += String.fromCharCode(byte);
			let response: Response;
			try {
				response = await fetch("/api/setup/restore", {
					method: "POST",
					body: file,
					headers: {
						"Accept-Language": i18n.locale,
						"Content-Type": "application/octet-stream",
						"X-Setup-Token": setupToken.trim(),
						"X-Backup-Sha256": sha256.trim(),
						"X-Encryption-Key": btoa(binary),
					},
				});
			} catch {
				throw new Error(
					i18n._(
						"Can't reach {appName}. Check your connection and try again.",
						{ appName: APP_NAME },
					),
				);
			}
			const payload = (await response.json().catch(() => ({}))) as {
				message?: string;
			} & Partial<FirstRunRestoreResult>;
			if (!response.ok) {
				throw new Error(
					payload.message ?? i18n._("The restore failed. Try again."),
				);
			}
			return payload as FirstRunRestoreResult;
		},
		// Setup state and the signed-out caches are now stale.
		onSuccess: () => queryClient.clear(),
	});

	if (restore.data) {
		const result = restore.data;
		return (
			<Stack gap="md">
				<Title order={2}>
					{i18n._("{appName} was restored", { appName: APP_NAME })}
				</Title>
				<Alert color="green" variant="light">
					<Text size="sm">
						{i18n._(
							"The backup from {date} is loaded ({accounts, plural, one {# account} other {# accounts}}). Sign in with your usual account.",
							{
								date: formatDate(i18n.locale, result.backupCreatedAt, {
									dateStyle: "medium",
									timeStyle: "short",
								}),
								accounts: result.accounts,
							},
						)}
					</Text>
				</Alert>
				<List size="sm" spacing={6}>
					<List.Item>
						{i18n._(
							'The installation starts paused: no jobs, schedules or monitoring run until you choose "This database was moved — resume here". Stop the old installation for good first.',
						)}
					</List.Item>
					{result.keyChanged && (
						<List.Item>
							{i18n._(
								"The backup used another ENCRYPTION_KEY: stored secrets were re-encrypted ({count}). Add the old key to ENCRYPTION_KEY_PREVIOUS in .env and restart, so app backups made by the old installation can still be restored.",
								{ count: result.reencrypted },
							)}
						</List.Item>
					)}
				</List>
				<Button component={LocalizedLink} to="/{-$locale}/login">
					{i18n._("Sign in")}
				</Button>
			</Stack>
		);
	}

	const ready =
		!!file && key.length >= 32 && /^[0-9a-fA-F]{64}$/.test(sha256.trim());
	return (
		<Stack gap="md">
			<Title order={2}>
				{i18n._("Restore {appName} from a self-backup", { appName: APP_NAME })}
			</Title>
			<Text size="sm" c="dimmed">
				{i18n._(
					"Moving to a new machine? Upload the latest {appName} backup ({file} from your destination) instead of creating a new administrator.",
					{
						appName: APP_NAME,
						file: SELF_BACKUP_EXAMPLE,
					},
				)}
			</Text>
			<FileInput
				label={i18n._("Backup file")}
				placeholder={i18n._("Choose the .tar.gz.enc file")}
				accept=".enc,application/octet-stream"
				value={file}
				onChange={setFile}
				leftSection={<DatabaseBackup size={16} />}
				clearable
			/>
			{tokenRequired && (
				<TextInput
					label={i18n._("Setup token")}
					description={i18n._(
						"Printed by the installer (SETUP_TOKEN in the install's .env). Needed until the first account exists.",
					)}
					value={setupToken}
					onChange={(event) => setSetupToken(event.currentTarget.value)}
					spellCheck={false}
					autoComplete="off"
				/>
			)}
			<TextInput
				label={i18n._("sha256 of the backup")}
				description={i18n._(
					"The checksum shown in Data → Backups and in the backup's job log. The file is refused if it does not match.",
				)}
				value={sha256}
				onChange={(event) => setSha256(event.currentTarget.value)}
				spellCheck={false}
				autoComplete="off"
			/>
			<SecretInput
				label={i18n._("ENCRYPTION_KEY of the old installation")}
				description={i18n._(
					"Needed to decrypt the backup and the secrets inside it. It is not stored.",
				)}
				value={key}
				onChange={(event) => setKey(event.currentTarget.value)}
				autoComplete="off"
			/>
			{restore.error && (
				<Alert color="red" variant="light">
					{restore.error.message}
				</Alert>
			)}
			<Button
				loading={restore.isPending}
				disabled={!ready}
				onClick={() => restore.mutate()}
			>
				{i18n._("Verify and restore")}
			</Button>
		</Stack>
	);
};
