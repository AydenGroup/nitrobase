import { useLingui } from "@lingui/react";
import {
	Alert,
	Button,
	Checkbox,
	Group,
	Modal,
	Select,
	SimpleGrid,
	Stack,
	Switch,
	Text,
	TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useCan } from "#/components/teams/useCan";
import { SecretInput } from "#/components/ui/SecretInput.tsx";
import { useAppMutation } from "#/components/ui/useAppMutation";
import {
	DATABASE_TEMPLATE_ID,
	DATABASE_URL_PARTS,
	type DatabaseEngineId,
	type DatabaseUrlPart,
	databaseEngine,
	databaseUrlPartLabels,
} from "#/config/database-engines.ts";
import { appsQueryOptions } from "#/features/apps/apps.query.ts";
import { linkDatabaseFn } from "#/features/databases/databases.functions.ts";
import { databasesQueryOptions } from "#/features/databases/databases.query.ts";

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Link a database to an app on the same server. Opened from a database
 * (pick the app) or from an app (pick the database). Starts the link job
 * (`onStarted` gets its id for the log drawer).
 */
export const LinkDatabaseModal: React.FC<{
	opened: boolean;
	onClose: () => void;
	serverId: string;
	/** Fixed database (from the database page). */
	database?: { id: string; engine: DatabaseEngineId; name: string };
	/** Fixed app (from the app page). */
	app?: { id: string; name: string };
	/** Already linked (hidden from the picker). */
	linkedIds: string[];
	onStarted: (deploymentId: string) => void;
}> = ({ opened, onClose, serverId, database, app, linkedIds, onStarted }) => {
	const { i18n } = useLingui();
	const can = useCan();
	// The main login is the superuser: linking it needs database.write.
	const mainLoginAllowed = can("database.write");
	const apps = useQuery({ ...appsQueryOptions, enabled: opened && !app });
	const databases = useQuery({
		...databasesQueryOptions(),
		enabled: opened && !database,
	});
	const [appId, setAppId] = useState<string | null>(app?.id ?? null);
	const [databaseId, setDatabaseId] = useState<string | null>(
		database?.id ?? null,
	);
	const picked = database
		? database
		: (databases.data ?? []).find((item) => item.id === databaseId);
	const engine = picked?.engine;
	const definition = engine ? databaseEngine(engine) : null;
	const [urlEnv, setUrlEnv] = useState("");
	const [withParts, setWithParts] = useState(false);
	const [partNames, setPartNames] = useState<
		Partial<Record<DatabaseUrlPart, string>>
	>({});
	const [customLoginChoice, setCustomLogin] = useState(false);
	const customLogin = customLoginChoice || !mainLoginAllowed;
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [targetDatabase, setTargetDatabase] = useState("");
	const [redeploy, setRedeploy] = useState(true);

	useEffect(() => {
		if (!definition) return;
		setUrlEnv(definition.linkEnv.url);
		setPartNames({ ...definition.linkEnv.parts });
	}, [definition]);
	useEffect(() => {
		if (!opened) {
			setCustomLogin(false);
			setUsername("");
			setPassword("");
			setTargetDatabase("");
			setWithParts(false);
		}
	}, [opened]);

	const sameServerApps = (apps.data ?? []).filter(
		(item) =>
			item.serverId === serverId &&
			item.templateId !== DATABASE_TEMPLATE_ID &&
			!linkedIds.includes(item.id),
	);
	const otherServerApps = (apps.data ?? []).filter(
		(item) =>
			item.serverId !== serverId && item.templateId !== DATABASE_TEMPLATE_ID,
	);
	const sameServerDatabases = (databases.data ?? []).filter(
		(item) => item.serverId === serverId && !linkedIds.includes(item.id),
	);

	const link = useAppMutation({
		mutationFn: async () =>
			await linkDatabaseFn({
				data: {
					databaseId: picked?.id ?? "",
					appId: appId ?? "",
					urlEnv,
					parts: withParts
						? Object.fromEntries(
								Object.entries(partNames).filter(([, name]) => !!name),
							)
						: {},
					database: targetDatabase.trim() || undefined,
					username: customLogin ? username.trim() || undefined : undefined,
					password: customLogin ? password || undefined : undefined,
					redeploy,
				},
			}),
		field: "link",
		success: i18n._("Link created"),
		onSuccess: ({ deploymentId }) => {
			onClose();
			onStarted(deploymentId);
		},
	});

	const partsValid =
		!withParts ||
		Object.values(partNames).every((name) => !name || ENV_NAME.test(name));
	const valid =
		!!picked &&
		!!appId &&
		ENV_NAME.test(urlEnv) &&
		partsValid &&
		(!customLogin || (username.trim() !== "" && password !== ""));

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={i18n._("Link a database to an app")}
			size="lg"
		>
			<Stack>
				<Text size="sm" c="dimmed">
					{i18n._(
						"The app gets the connection URL as an environment variable and a private network to the database. Only linked apps can reach it.",
					)}
				</Text>
				{database ? null : (
					<Select
						label={i18n._("Database")}
						placeholder={i18n._("Select a database")}
						data={sameServerDatabases.map((item) => ({
							value: item.id,
							label: `${item.name} (${databaseEngine(item.engine).name} ${item.tag})`,
						}))}
						value={databaseId}
						onChange={setDatabaseId}
						nothingFoundMessage={i18n._("No database on this app's server")}
					/>
				)}
				{app ? null : (
					<Select
						label={i18n._("App")}
						placeholder={i18n._("Select an app")}
						data={sameServerApps.map((item) => ({
							value: item.id,
							label: item.name,
						}))}
						value={appId}
						onChange={setAppId}
						nothingFoundMessage={i18n._("No other app on this server")}
					/>
				)}
				{!app && otherServerApps.length > 0 && (
					<Text size="xs" c="dimmed">
						{i18n._(
							"Apps on other servers can't be linked (the link is a private network on one server): move the app, or publish the database port and use its external address.",
						)}
					</Text>
				)}
				<TextInput
					label={i18n._("Connection URL variable")}
					value={urlEnv}
					error={
						urlEnv && !ENV_NAME.test(urlEnv)
							? i18n._("Use capital letters, digits and _")
							: undefined
					}
					onChange={(event) => setUrlEnv(event.currentTarget.value)}
					ff="monospace"
				/>
				{definition && Object.keys(definition.linkEnv.parts).length > 0 && (
					<Switch
						label={i18n._("Also set host, port, user and password separately")}
						checked={withParts}
						onChange={(event) => setWithParts(event.currentTarget.checked)}
					/>
				)}
				{withParts && definition && (
					<SimpleGrid cols={{ base: 1, sm: 2 }}>
						{DATABASE_URL_PARTS.filter(
							(part) => part in definition.linkEnv.parts,
						).map((part) => (
							<TextInput
								key={part}
								label={i18n._(databaseUrlPartLabels[part])}
								value={partNames[part] ?? ""}
								onChange={(event) => {
									const value = event.currentTarget.value;
									setPartNames((current) => ({ ...current, [part]: value }));
								}}
								ff="monospace"
							/>
						))}
					</SimpleGrid>
				)}
				{definition?.defaultDatabase !== null && (
					<TextInput
						label={i18n._("Database (optional)")}
						description={i18n._(
							"Default: the database's own. Create others under Users & databases.",
						)}
						value={targetDatabase}
						onChange={(event) => setTargetDatabase(event.currentTarget.value)}
					/>
				)}
				{definition?.manageUsers && (
					<Checkbox
						label={i18n._(
							"Use another login (created under Users & databases)",
						)}
						checked={customLogin}
						onChange={(event) => setCustomLogin(event.currentTarget.checked)}
					/>
				)}
				{customLogin && (
					<SimpleGrid cols={{ base: 1, sm: 2 }}>
						<TextInput
							label={i18n._("User")}
							autoComplete="off"
							value={username}
							onChange={(event) => setUsername(event.currentTarget.value)}
						/>
						<SecretInput
							label={i18n._("Password")}
							value={password}
							onChange={(event) => setPassword(event.currentTarget.value)}
						/>
					</SimpleGrid>
				)}
				<Checkbox
					label={i18n._("Redeploy the app now so it gets the variables")}
					checked={redeploy}
					onChange={(event) => setRedeploy(event.currentTarget.checked)}
				/>
				{link.fieldError("link") && (
					<Alert color="red">{link.fieldError("link")}</Alert>
				)}
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{i18n._("Cancel")}
					</Button>
					<Button
						disabled={!valid}
						loading={link.isPending}
						onClick={() => link.mutate()}
					>
						{i18n._("Link")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
};
