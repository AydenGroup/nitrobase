import { useLingui } from "@lingui/react";
import {
	Alert,
	Button,
	Group,
	NumberInput,
	Radio,
	Select,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
	liveServerStatus,
	useUnreachableServers,
} from "#/components/monitoring/ServerLiveStatus";
import { SectionCard } from "#/components/ui/SectionCard";
import { useAppMutation } from "#/components/ui/useAppMutation";
import {
	DATABASE_ENGINE_IDS,
	type DatabaseEngineId,
	databaseEngine,
	databaseEngines,
} from "#/config/database-engines.ts";
import { APP_NAME } from "#/config/shared.ts";
import { createDatabaseFn } from "#/features/databases/databases.functions.ts";
import { serversQueryOptions } from "#/features/servers/servers.query.ts";
import { localeParams } from "#/libs/i18n.ts";
import { EngineBadge } from "./EngineBadge";

const NAME = /^[a-z_][a-z0-9_]{0,30}$/;

/** New database: engine, version, server, name, login and memory limit. */
export const CreateDatabaseForm: React.FC = () => {
	const { i18n } = useLingui();
	const navigate = useNavigate();
	const { data: servers = [] } = useQuery(serversQueryOptions);
	const unreachable = useUnreachableServers();
	const ready = servers.filter(
		(server) => liveServerStatus(server, unreachable) === "ready",
	);
	const [engine, setEngine] = useState<DatabaseEngineId>("postgres");
	const definition = databaseEngine(engine);
	const [version, setVersion] = useState<string>(definition.defaultVersion);
	const [serverId, setServerId] = useState<string | null>(
		ready.length === 1 ? ready[0].id : null,
	);
	const [name, setName] = useState("");
	const [user, setUser] = useState("");
	const [database, setDatabase] = useState("");
	const [memoryMb, setMemoryMb] = useState<number | string>(
		definition.memoryMb,
	);

	const pickEngine = (id: DatabaseEngineId) => {
		setEngine(id);
		setVersion(databaseEngines[id].defaultVersion);
		setMemoryMb(databaseEngines[id].memoryMb);
	};

	const create = useAppMutation({
		mutationFn: async () =>
			await createDatabaseFn({
				data: {
					serverId: serverId ?? "",
					name: name.trim(),
					engine,
					version,
					user: user.trim() || undefined,
					database: database.trim() || undefined,
					memoryMb: typeof memoryMb === "number" ? memoryMb : undefined,
				},
			}),
		field: "form",
		onSuccess: ({ appId, deploymentId }) => {
			navigate({
				to: "/{-$locale}/databases/$databaseId",
				params: { ...localeParams(i18n.locale), databaseId: appId },
				search: { tab: "deployments", job: deploymentId },
			});
		},
	});

	const userError =
		user && !NAME.test(user)
			? i18n._("Lowercase letters, digits and _ (up to 31 characters)")
			: undefined;
	const databaseError =
		database && !NAME.test(database)
			? i18n._("Lowercase letters, digits and _ (up to 31 characters)")
			: undefined;
	const valid =
		!!serverId && name.trim().length > 0 && !userError && !databaseError;

	return (
		<Stack gap="lg" maw={880}>
			<SectionCard title={i18n._("Engine")}>
				<Radio.Group
					value={engine}
					onChange={(value) => pickEngine(value as DatabaseEngineId)}
				>
					<SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
						{DATABASE_ENGINE_IDS.map((id) => (
							<Radio.Card key={id} value={id} p="md" radius="md">
								<Stack gap={6}>
									<Group justify="space-between" wrap="nowrap">
										<EngineBadge engine={id} />
										<Radio.Indicator />
									</Group>
									<Text size="xs" c="dimmed">
										{i18n._(databaseEngines[id].description)}
									</Text>
									<Text size="xs" c="dimmed">
										{i18n._("Licence: {license}", {
											license: databaseEngines[id].license,
										})}
									</Text>
								</Stack>
							</Radio.Card>
						))}
					</SimpleGrid>
				</Radio.Group>
				{definition.licenseNote && (
					<Alert color="yellow" mt="md">
						{i18n._(definition.licenseNote)}
					</Alert>
				)}
			</SectionCard>

			<SectionCard title={i18n._("Database")}>
				<Stack>
					<TextInput
						label={i18n._("Name")}
						description={i18n._("Shown in {appName}, e.g. “shop-db”.", {
							appName: APP_NAME,
						})}
						value={name}
						onChange={(event) => setName(event.currentTarget.value)}
						required
					/>
					<SimpleGrid cols={{ base: 1, sm: 2 }}>
						<Select
							label={i18n._("Version")}
							data={definition.versions.map((item) => item.tag)}
							value={version}
							onChange={(value) => value && setVersion(value)}
							allowDeselect={false}
						/>
						<Select
							label={i18n._("Server")}
							placeholder={i18n._("Select a server")}
							data={ready.map((server) => ({
								value: server.id,
								label: `${server.name} (${server.host})`,
							}))}
							value={serverId}
							onChange={setServerId}
							nothingFoundMessage={i18n._("No bootstrapped server yet")}
						/>
					</SimpleGrid>
					{ready.length === 0 && (
						<Alert color="yellow">
							{i18n._(
								"No bootstrapped server yet. Bootstrap a server before creating databases.",
							)}
						</Alert>
					)}
					{definition.defaultUser !== null && (
						<SimpleGrid cols={{ base: 1, sm: 2 }}>
							<TextInput
								label={i18n._("User")}
								placeholder={definition.defaultUser}
								value={user}
								error={userError}
								onChange={(event) => setUser(event.currentTarget.value)}
							/>
							<TextInput
								label={i18n._("Database name")}
								placeholder={definition.defaultDatabase ?? ""}
								value={database}
								error={databaseError}
								onChange={(event) => setDatabase(event.currentTarget.value)}
							/>
						</SimpleGrid>
					)}
					<NumberInput
						label={i18n._("Memory limit (MiB)")}
						description={i18n._(
							"Suggested for {engine}; change it later in Settings → Resource limits.",
							{ engine: definition.name },
						)}
						min={64}
						step={64}
						value={memoryMb}
						onChange={setMemoryMb}
						maw={260}
					/>
					<Text size="xs" c="dimmed">
						{i18n._(
							"The password is generated and stored encrypted. The database is reachable only from apps you link to it; publishing its port is optional (Settings).",
						)}
					</Text>
				</Stack>
			</SectionCard>

			{create.fieldError("form") && (
				<Alert color="red" title={i18n._("The database was not created")}>
					{create.fieldError("form")}
				</Alert>
			)}
			<Group justify="flex-end">
				<Button
					disabled={!valid}
					loading={create.isPending}
					onClick={() => create.mutate()}
				>
					{i18n._("Create database")}
				</Button>
			</Group>
		</Stack>
	);
};
