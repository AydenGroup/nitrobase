import { useLingui } from "@lingui/react";
import {
	Alert,
	Anchor,
	Badge,
	Button,
	Group,
	Stack,
	Text,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, RefreshCw, ShieldAlert, Wrench } from "lucide-react";
import { useState } from "react";
import { AppJobDrawer } from "#/components/apps/AppJobDrawer";
import { RotateHookCheckbox } from "#/components/apps/RotateHookCheckbox";
import { useAppJob } from "#/components/apps/useAppJob";
import { BackupFirstCheckbox } from "#/components/backups/BackupFirstCheckbox";
import { useCan } from "#/components/teams/useCan";
import { ConfirmDanger } from "#/components/ui/ConfirmDanger";
import { CopyField } from "#/components/ui/CopyField";
import { KeyValueList } from "#/components/ui/KeyValueList";
import { SecretField, useRevealConfirm } from "#/components/ui/SecretField";
import { SectionCard } from "#/components/ui/SectionCard";
import { APP_NAME } from "#/config/shared.ts";
import { appStatuses, isBusy } from "#/config/status.ts";
import {
	revealCredentialFn,
	rotateVariableFn,
} from "#/features/apps/apps.functions.ts";
import type { SupabaseOverview } from "#/features/supabase/schema.ts";
import { repairStorageMetadataFn } from "#/features/supabase/supabase.functions.ts";
import { supabaseOverviewQueryOptions } from "#/features/supabase/supabase.query.ts";
import { translateTemplateText } from "#/libs/i18n.ts";
import type { PluginTabProps } from "#/plugins/types.ts";

/** Supabase API page: URLs, keys (new and legacy), Studio credentials, rotation. */
export default function SupabaseApiTab({ overview }: PluginTabProps) {
	const { i18n } = useLingui();
	const can = useCan();
	const { app } = overview;
	const jobs = useAppJob(app.id);
	const [rotateJwtOpen, setRotateJwtOpen] = useState(false);
	const [backupFirst, setBackupFirst] = useState(false);
	/** The JWT secret's template step (sign users out); null: its default. */
	const [runRotateHook, setRunRotateHook] = useState<boolean | null>(null);
	const { data, error } = useQuery(supabaseOverviewQueryOptions(app.id));
	const busy = jobs.isStarting || isBusy(appStatuses, app.status);

	if (error) {
		return <Alert color="red">{error.message}</Alert>;
	}
	if (!data) return null;

	const reveal = (name: string) => () =>
		revealCredentialFn({ data: { appId: app.id, name } });
	const rotate = (
		name: string,
		title: string,
		backupFirst = false,
		runRotateHook?: boolean,
	) =>
		jobs.startJob({
			title,
			start: () =>
				rotateVariableFn({
					data: { appId: app.id, name, backupFirst, runRotateHook },
				}),
		});
	const jwtHook = data.jwtSecretRotateHook;
	const signOut = runRotateHook ?? jwtHook?.default ?? false;

	const confirmRotateStudio = () =>
		modals.openConfirmModal({
			title: i18n._("Rotate Studio password"),
			centered: true,
			children: (
				<Text size="sm">
					{i18n._(
						"A new Studio password is generated and the app is redeployed. Anyone using the old password is signed out of Studio.",
					)}
				</Text>
			),
			labels: { confirm: i18n._("Rotate"), cancel: i18n._("Cancel") },
			onConfirm: () =>
				rotate(data.studioPasswordName, i18n._("Rotate Studio password")),
		});

	const confirmRotateSecret = (name: string) =>
		modals.openConfirmModal({
			title: i18n._("Rotate secret key"),
			centered: true,
			children: (
				<Text size="sm">
					{i18n._(
						"A new secret key is generated and the app is redeployed. Servers using the old secret key must be updated; the publishable key, the legacy keys and user sessions are not affected.",
					)}
				</Text>
			),
			labels: { confirm: i18n._("Rotate"), cancel: i18n._("Cancel") },
			onConfirm: () => rotate(name, i18n._("Rotate secret key")),
		});

	const confirmRepairStorage = () =>
		modals.openConfirmModal({
			title: i18n._("Repair storage metadata"),
			centered: true,
			children: (
				<Text size="sm">
					{i18n._(
						"The repair runs while the app stays live. Every storage object in the database is checked against its file, and only missing content type and cache control attributes are added: nothing is overwritten or deleted. Large storage folders take a while.",
					)}
				</Text>
			),
			labels: { confirm: i18n._("Repair"), cancel: i18n._("Cancel") },
			onConfirm: () =>
				jobs.startJob({
					title: i18n._("Repair storage metadata"),
					start: () => repairStorageMetadataFn({ data: { appId: app.id } }),
				}),
		});

	return (
		<Stack gap="md">
			{!data.anonKey && (
				<Alert color="yellow">
					{i18n._("Keys are generated on the first deploy.")}
				</Alert>
			)}
			<SectionCard title={i18n._("API")}>
				<KeyValueList
					items={[
						{
							label: i18n._("API URL"),
							value: data.apiUrl ? <CopyField value={data.apiUrl} /> : null,
						},
						{
							label: i18n._("Studio URL"),
							value: data.studioUrl ? (
								<Stack gap={4}>
									<Group gap="xs">
										<Anchor
											href={data.studioUrl}
											target="_blank"
											rel="noreferrer"
											size="sm"
										>
											{data.studioUrl}
										</Anchor>
										{data.studioProtected && (
											<Badge size="xs" variant="light" color="green">
												{i18n._("Basic auth")}
											</Badge>
										)}
									</Group>
									{!data.studioProtected && (
										<Text size="xs" c="dimmed">
											{i18n._(
												"Studio is served by the API gateway. Add a domain for the studio service in Domains to put it behind {appName} basic auth.",
												{ appName: APP_NAME },
											)}
										</Text>
									)}
								</Stack>
							) : null,
						},
					]}
				/>
			</SectionCard>

			<SectionCard
				title={i18n._("API keys")}
				description={
					data.newKeys === "unsupported"
						? i18n._(
								"The anon key is safe in browsers (Row Level Security applies). The service_role key bypasses RLS: use it only on servers.",
							)
						: i18n._(
								"The publishable key is safe in browsers (Row Level Security applies). The secret key bypasses RLS: use it only on servers.",
							)
				}
				actions={
					data.secretKeyName &&
					data.secretKeyRotatable && (
						<Button
							variant="light"
							size="xs"
							leftSection={<RefreshCw size={14} />}
							disabled={busy || !can("app.env.edit")}
							onClick={() => confirmRotateSecret(data.secretKeyName as string)}
						>
							{i18n._("Rotate secret key")}
						</Button>
					)
				}
			>
				<Stack gap="md">
					<NewKeys data={data} reveal={reveal} />
					{data.newKeys !== "unsupported" && (
						<Stack gap={2}>
							<Group gap="xs">
								<Text size="sm" fw={500}>
									{i18n._("JWT-based keys")}
								</Text>
								<Badge size="xs" variant="light" color="gray">
									{i18n._("Legacy")}
								</Badge>
							</Group>
							<Text size="xs" c="dimmed">
								{i18n._(
									"anon and service_role are JWTs signed with the JWT secret. They keep working; prefer the publishable and secret keys for new clients.",
								)}
							</Text>
						</Stack>
					)}
					<KeyValueList
						cols={1}
						items={[
							{
								label: "anon",
								value: data.anonKey ? <CopyField value={data.anonKey} /> : null,
							},
							{
								label: "service_role",
								value: data.anonKey ? (
									<SecretField
										name={data.serviceKeyName}
										onReveal={reveal(data.serviceKeyName)}
									/>
								) : null,
							},
						]}
					/>
				</Stack>
			</SectionCard>

			<SectionCard
				title={i18n._("Studio credentials")}
				description={i18n._(
					"Studio is protected with HTTP basic auth using these credentials.",
				)}
				actions={
					<Button
						variant="light"
						size="xs"
						leftSection={<RefreshCw size={14} />}
						disabled={busy || !data.studioUsername || !can("app.env.edit")}
						onClick={confirmRotateStudio}
					>
						{i18n._("Rotate password")}
					</Button>
				}
			>
				<KeyValueList
					items={[
						{
							label: i18n._("Username"),
							value: data.studioUsername ? (
								<CopyField value={data.studioUsername} />
							) : null,
						},
						{
							label: i18n._("Password"),
							value: data.studioUsername ? (
								<SecretField
									name={data.studioPasswordName}
									onReveal={reveal(data.studioPasswordName)}
								/>
							) : null,
						},
					]}
				/>
			</SectionCard>

			<ConnectCard
				appId={app.id}
				apiUrl={data.apiUrl}
				clientKey={data.publishableKey ?? data.anonKey}
				pooler={data.pooler}
				dbPasswordName={data.dbPasswordName}
			/>

			{data.storageRepair && (
				<SectionCard
					title={i18n._("Storage files")}
					description={i18n._(
						"Storage keeps each file's content type and cache control in its extended attributes. Files restored from a backup made before backups kept them answer with an error; the repair rebuilds the missing ones from the database.",
					)}
					actions={
						<Button
							variant="light"
							size="xs"
							leftSection={<Wrench size={14} />}
							disabled={busy || !can("app.deploy")}
							onClick={confirmRepairStorage}
						>
							{i18n._("Repair storage metadata")}
						</Button>
					}
				>
					<Text size="sm" c="dimmed">
						{i18n._(
							"Only missing attributes are set; files and existing attributes are not changed. The app keeps running.",
						)}
					</Text>
				</SectionCard>
			)}

			<SectionCard
				tone="danger"
				title={i18n._("JWT secret")}
				description={
					data.newKeys === "ready"
						? i18n._(
								"Rotating the JWT secret regenerates the signing keys (the JWT secret and the ES256 key pair) and the anon and service_role keys, then redeploys the app. The publishable and secret keys stay the same.",
							)
						: i18n._(
								"Rotating the JWT secret regenerates the anon and service_role keys and redeploys the app.",
							)
				}
				actions={
					<Button
						color="red"
						variant="light"
						size="xs"
						leftSection={<KeyRound size={14} />}
						disabled={busy || !can("app.env.edit")}
						onClick={() => {
							setRunRotateHook(null); // the checkbox starts at its default
							setRotateJwtOpen(true);
						}}
					>
						{i18n._("Rotate JWT secret")}
					</Button>
				}
			>
				<Group gap="xs" wrap="nowrap" align="flex-start">
					<ShieldAlert size={16} style={{ flexShrink: 0, marginTop: 2 }} />
					<Text size="sm" c="dimmed">
						{data.newKeys === "ready"
							? i18n._(
									"Every existing access token becomes invalid and clients using the anon or service_role key must be updated.",
								)
							: i18n._(
									"Every existing access token becomes invalid and clients must be updated with the new keys.",
								)}{" "}
						{jwtHook
							? i18n._(
									"Signed-in users can be signed out as part of the rotation (offered in the dialog).",
								)
							: i18n._(
									"Signed-in users stay signed in: their sessions keep refreshing with the new secret.",
								)}
					</Text>
				</Group>
			</SectionCard>

			<ConfirmDanger
				opened={rotateJwtOpen}
				onClose={() => setRotateJwtOpen(false)}
				title={i18n._("Rotate JWT secret")}
				description={
					data.newKeys === "ready"
						? i18n._(
								"A new JWT secret, ES256 signing key, anon key and service_role key are generated and the app is redeployed. Every existing access token becomes invalid; the publishable and secret keys keep working.",
							)
						: i18n._(
								"A new JWT secret, anon key and service_role key are generated and the app is redeployed. Every existing access token becomes invalid.",
							)
				}
				confirmName={app.folder}
				confirmLabel={i18n._("Rotate and redeploy")}
				loading={jobs.isStarting}
				onConfirm={() => {
					setRotateJwtOpen(false);
					rotate(
						data.jwtSecretName,
						i18n._("Rotate JWT secret"),
						backupFirst,
						jwtHook ? signOut : undefined,
					);
				}}
			>
				{jwtHook && (
					<RotateHookCheckbox hook={jwtHook} onChange={setRunRotateHook} />
				)}
				<BackupFirstCheckbox
					appId={app.id}
					checked={backupFirst}
					onChange={setBackupFirst}
				/>
			</ConfirmDanger>
			<AppJobDrawer
				job={jobs.job}
				appName={app.name}
				onClose={jobs.closeJob}
				onCompleted={() => jobs.refresh()}
			/>
		</Stack>
	);
}

/** The new API keys, or why the app does not have them yet. */
function NewKeys({
	data,
	reveal,
}: {
	data: SupabaseOverview;
	reveal: (name: string) => () => Promise<string>;
}) {
	const { i18n } = useLingui();
	if (data.newKeys === "unsupported") return null;
	if (data.newKeys === "redeploy") {
		return (
			<Alert color="blue">
				{i18n._(
					"Redeploy the app to generate the publishable and secret keys. The anon and service_role keys stay the same.",
				)}
			</Alert>
		);
	}
	if (data.newKeys === "update") {
		return (
			<Alert color="blue">
				{i18n._(
					"Publishable and secret keys need Supabase {version} or later: update the app to get them.",
					{ version: data.newKeysVersion ?? "" },
				)}
			</Alert>
		);
	}
	return (
		<KeyValueList
			cols={1}
			items={[
				{
					label: i18n._("Publishable key"),
					value: data.publishableKey ? (
						<CopyField value={data.publishableKey} />
					) : null,
				},
				{
					label: i18n._("Secret key"),
					value: data.secretKeyName ? (
						<SecretField
							name={data.secretKeyName}
							onReveal={reveal(data.secretKeyName)}
						/>
					) : null,
				},
				...(data.jwksUrl
					? [
							{
								label: i18n._("JWKS URL"),
								value: (
									<Stack gap={2}>
										<CopyField value={data.jwksUrl} />
										<Text size="xs" c="dimmed">
											{i18n._(
												"Public keys to verify the app's user tokens (ES256) on your own servers.",
											)}
										</Text>
									</Stack>
								),
							},
						]
					: []),
			]}
		/>
	);
}

/** Copyable snippets for connecting a client and psql. */
function ConnectCard({
	appId,
	apiUrl,
	clientKey,
	pooler,
	dbPasswordName,
}: {
	appId: string;
	apiUrl: string | null;
	/** Publishable key, or the legacy anon key without one. */
	clientKey: string | null;
	pooler: SupabaseOverview["pooler"];
	dbPasswordName: string;
}) {
	const { i18n } = useLingui();
	const confirm = useRevealConfirm();
	const [password, setPassword] = useState<string | null>(null);
	const placeholder = `[${dbPasswordName}]`;
	const snippet = [
		'import { createClient } from "@supabase/supabase-js";',
		"",
		"const supabase = createClient(",
		`  "${apiUrl ?? ""}",`,
		`  "${clientKey ?? ""}",`,
		");",
	].join("\n");
	return (
		<SectionCard
			title={i18n._("Connect")}
			description={i18n._(
				"Project URL, client snippet and Postgres connection strings.",
			)}
		>
			<Stack gap="md">
				<KeyValueList
					cols={1}
					items={[
						{
							label: i18n._("Project URL"),
							value: apiUrl ? <CopyField value={apiUrl} /> : null,
						},
					]}
				/>
				<Stack gap={4}>
					<Text size="xs" c="dimmed" fw={500} tt="uppercase">
						supabase-js
					</Text>
					<CopyField value={snippet} block />
				</Stack>
				<Stack gap={4}>
					<Group justify="space-between">
						<Text size="xs" c="dimmed" fw={500} tt="uppercase">
							{i18n._("Postgres (through the pooler)")}
						</Text>
						{pooler.length > 0 && password === null && (
							<Button
								size="compact-xs"
								variant="subtle"
								onClick={() =>
									confirm(dbPasswordName, async () =>
										setPassword(
											await revealCredentialFn({
												data: { appId, name: dbPasswordName },
											}),
										),
									)
								}
							>
								{i18n._("Show with password")}
							</Button>
						)}
					</Group>
					{pooler.length === 0 ? (
						<Text size="sm" c="dimmed">
							{i18n._(
								"The pooler is not published on the host. Enable it in Settings → Published ports to connect with psql or pg_dump from outside.",
							)}
						</Text>
					) : (
						pooler.map((entry) => {
							const url =
								password === null
									? entry.connection
									: entry.connection.replace(
											placeholder,
											encodeURIComponent(password),
										);
							return (
								<Stack key={entry.hostPort} gap={2}>
									<Text size="xs" c="dimmed">
										{translateTemplateText(i18n, entry.label)} · :
										{entry.hostPort} ·{" "}
										{entry.loopback
											? i18n._(
													"Bound on the server's 127.0.0.1: open an SSH tunnel first (ssh -L {port}:127.0.0.1:{port} user@server), then connect locally.",
													{ port: entry.hostPort },
												)
											: i18n._(
													"The host is the server address configured in {appName}; use its public IP or DNS name from outside.",
													{ appName: APP_NAME },
												)}
									</Text>
									<CopyField value={`psql "${url}"`} />
								</Stack>
							);
						})
					)}
				</Stack>
			</Stack>
		</SectionCard>
	);
}
