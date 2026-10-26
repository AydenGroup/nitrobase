import { useLingui } from "@lingui/react";
import {
	Alert,
	Badge,
	Button,
	Group,
	Modal,
	Select,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useCan } from "#/components/teams/useCan";
import { ConfirmDanger } from "#/components/ui/ConfirmDanger";
import { CopyField } from "#/components/ui/CopyField";
import { DataTable } from "#/components/ui/DataTable";
import { SectionCard } from "#/components/ui/SectionCard";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { databaseEngines } from "#/config/database-engines.ts";
import { APP_NAME } from "#/config/shared.ts";
import type { AppOverview } from "#/features/apps/schema.ts";
import {
	createManagedDatabaseFn,
	createManagedUserFn,
	dropManagedFn,
	grantDatabaseFn,
} from "#/features/databases/databases.functions.ts";
import { databaseUsersQueryOptions } from "#/features/databases/databases.query.ts";
import type {
	DatabaseOverview,
	ManagedUser,
} from "#/features/databases/schema.ts";
import { formatBytes } from "#/libs/intl.ts";

const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_$-]{0,63}$/;
const USER_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;

/** Databases and logins of a Postgres / MySQL / MariaDB server. */
export const DatabaseUsersTab: React.FC<{
	overview: AppOverview;
	database: DatabaseOverview;
}> = ({ database }) => {
	const { i18n } = useLingui();
	const can = useCan();
	// Logins, grants and drops need database.write (manage creates databases).
	const canWrite = can("database.write");
	const queryClient = useQueryClient();
	const list = useQuery({
		...databaseUsersQueryOptions(database.id),
		enabled: database.status === "running",
		retry: false,
	});
	const refresh = () =>
		queryClient.invalidateQueries({
			queryKey: ["databases", database.id, "users"],
		});
	const [newDatabase, setNewDatabase] = useState<string | null>(null);
	const [owner, setOwner] = useState<string | null>(null);
	const [newUser, setNewUser] = useState<string | null>(null);
	const [grantTo, setGrantTo] = useState<string | null>(null);
	const [created, setCreated] = useState<{
		name: string;
		password: string;
	} | null>(null);
	const [grant, setGrant] = useState<ManagedUser | null>(null);
	const [grantDatabase, setGrantDatabase] = useState<string | null>(null);
	const [drop, setDrop] = useState<{
		kind: "database" | "user";
		name: string;
		host?: string;
	} | null>(null);

	const createDatabase = useAppMutation({
		mutationFn: async () =>
			await createManagedDatabaseFn({
				data: {
					databaseId: database.id,
					name: newDatabase?.trim() ?? "",
					owner: owner ?? undefined,
				},
			}),
		field: "database",
		success: i18n._("Database created"),
		onSuccess: () => {
			setNewDatabase(null);
			setOwner(null);
			refresh();
		},
	});
	const createUser = useAppMutation({
		mutationFn: async () =>
			await createManagedUserFn({
				data: {
					databaseId: database.id,
					name: newUser?.trim() ?? "",
					grantDatabase: grantTo ?? undefined,
				},
			}),
		field: "user",
		onSuccess: ({ password }) => {
			setCreated({ name: newUser?.trim() ?? "", password });
			setNewUser(null);
			setGrantTo(null);
			refresh();
		},
	});
	const grantMutation = useAppMutation({
		mutationFn: async () =>
			await grantDatabaseFn({
				data: {
					databaseId: database.id,
					user: grant?.name ?? "",
					host: grant?.host,
					database: grantDatabase ?? "",
				},
			}),
		field: "grant",
		success: i18n._("Privileges granted"),
		onSuccess: () => {
			setGrant(null);
			setGrantDatabase(null);
		},
	});
	const dropMutation = useAppMutation({
		mutationFn: async (confirm: string) =>
			await dropManagedFn({
				data: {
					databaseId: database.id,
					kind: drop?.kind ?? "database",
					name: drop?.name ?? "",
					host: drop?.host,
					confirm,
				},
			}),
		field: "drop",
		success: i18n._("Dropped"),
		onSuccess: () => {
			setDrop(null);
			refresh();
		},
	});

	if (database.status !== "running") {
		return (
			<Alert color="yellow">
				{i18n._("The database is not running: start or redeploy it first.")}
			</Alert>
		);
	}
	const databases = list.data?.databases ?? [];
	const users = list.data?.users ?? [];
	const loginUsers = users.filter((user) => !user.protected);
	const databaseOptions = databases
		.filter((item) => !["template0", "template1"].includes(item.name))
		.map((item) => item.name);

	return (
		<Stack gap="md">
			{list.error && <Alert color="red">{list.error.message}</Alert>}
			<SectionCard
				title={i18n._("Databases")}
				actions={
					<Button
						size="xs"
						variant="light"
						leftSection={<Plus size={14} />}
						onClick={() => setNewDatabase("")}
					>
						{i18n._("New database")}
					</Button>
				}
				flush
			>
				<DataTable
					rows={databases}
					getRowKey={(item) => item.name}
					loading={list.isLoading}
					minWidth={480}
					columns={[
						{
							key: "name",
							header: i18n._("Name"),
							render: (item) => (
								<Group gap={6}>
									<Text size="sm" ff="monospace">
										{item.name}
									</Text>
									{item.protected && (
										<Badge size="xs" variant="light" color="gray">
											{i18n._("System")}
										</Badge>
									)}
									{item.linked && (
										<Badge size="xs" variant="light" color="blue">
											{i18n._("Used by a link")}
										</Badge>
									)}
								</Group>
							),
						},
						{
							key: "owner",
							header: i18n._("Owner"),
							hideOnMobile: true,
							render: (item) => item.owner ?? "—",
						},
						{
							key: "size",
							header: i18n._("Size"),
							render: (item) => formatBytes(i18n.locale, item.sizeBytes),
						},
						{
							key: "actions",
							header: "",
							align: "right",
							mobile: "actions",
							render: (item) =>
								item.protected ? null : (
									<Button
										size="xs"
										variant="subtle"
										color="red"
										onClick={() =>
											setDrop({ kind: "database", name: item.name })
										}
									>
										{i18n._("Drop")}
									</Button>
								),
						},
					]}
				/>
			</SectionCard>

			<SectionCard
				title={i18n._("Users")}
				actions={
					canWrite ? (
						<Button
							size="xs"
							variant="light"
							leftSection={<Plus size={14} />}
							onClick={() => setNewUser("")}
						>
							{i18n._("New user")}
						</Button>
					) : undefined
				}
				flush
			>
				<DataTable
					rows={users}
					getRowKey={(item) => `${item.name}@${item.host ?? ""}`}
					loading={list.isLoading}
					minWidth={480}
					columns={[
						{
							key: "name",
							header: i18n._("Name"),
							render: (item) => (
								<Group gap={6}>
									<Text size="sm" ff="monospace">
										{item.host ? `${item.name}@${item.host}` : item.name}
									</Text>
									{item.superuser && (
										<Badge size="xs" color="orange" variant="light">
											{i18n._("Superuser")}
										</Badge>
									)}
									{item.protected && (
										<Badge size="xs" variant="light" color="gray">
											{i18n._("System")}
										</Badge>
									)}
									{item.linked && (
										<Badge size="xs" variant="light" color="blue">
											{i18n._("Used by a link")}
										</Badge>
									)}
								</Group>
							),
						},
						{
							key: "actions",
							header: "",
							align: "right",
							mobile: "actions",
							render: (item) =>
								item.protected || !canWrite ? null : (
									<Group gap={4} justify="flex-end" wrap="nowrap">
										<Button
											size="xs"
											variant="subtle"
											onClick={() => setGrant(item)}
										>
											{i18n._("Grant")}
										</Button>
										<Button
											size="xs"
											variant="subtle"
											color="red"
											onClick={() =>
												setDrop({
													kind: "user",
													name: item.name,
													host: item.host,
												})
											}
										>
											{i18n._("Drop")}
										</Button>
									</Group>
								),
						},
					]}
				/>
			</SectionCard>

			<Modal
				opened={newDatabase !== null}
				onClose={() => setNewDatabase(null)}
				title={i18n._("New database")}
			>
				<Stack>
					<TextInput
						label={i18n._("Name")}
						value={newDatabase ?? ""}
						error={
							newDatabase && !DATABASE_NAME.test(newDatabase)
								? i18n._("Letters, digits, _ and - (starts with a letter or _)")
								: createDatabase.fieldError("database")
						}
						onChange={(event) => setNewDatabase(event.currentTarget.value)}
					/>
					{databaseEngines[database.engine].databaseOwner && (
						<Select
							label={i18n._("Owner (optional)")}
							data={loginUsers.map((user) => user.name)}
							value={owner}
							onChange={setOwner}
							clearable
						/>
					)}
					<Group justify="flex-end">
						<Button
							disabled={!newDatabase || !DATABASE_NAME.test(newDatabase)}
							loading={createDatabase.isPending}
							onClick={() => createDatabase.mutate()}
						>
							{i18n._("Create")}
						</Button>
					</Group>
				</Stack>
			</Modal>

			<Modal
				opened={newUser !== null}
				onClose={() => setNewUser(null)}
				title={i18n._("New user")}
			>
				<Stack>
					<TextInput
						label={i18n._("Name")}
						value={newUser ?? ""}
						error={
							newUser && !USER_NAME.test(newUser)
								? i18n._("Letters, digits, _ . and - (up to 32 characters)")
								: createUser.fieldError("user")
						}
						onChange={(event) => setNewUser(event.currentTarget.value)}
					/>
					<Select
						label={i18n._("Grant all privileges on (optional)")}
						data={databaseOptions}
						value={grantTo}
						onChange={setGrantTo}
						clearable
					/>
					<Text size="xs" c="dimmed">
						{i18n._(
							"A strong password is generated and shown once. {appName} doesn't keep it: use it when linking an app with this login.",
							{ appName: APP_NAME },
						)}
					</Text>
					<Group justify="flex-end">
						<Button
							disabled={!newUser || !USER_NAME.test(newUser)}
							loading={createUser.isPending}
							onClick={() => createUser.mutate()}
						>
							{i18n._("Create")}
						</Button>
					</Group>
				</Stack>
			</Modal>

			<Modal
				opened={created !== null}
				onClose={() => setCreated(null)}
				title={i18n._("User created")}
			>
				<Stack>
					<Alert color="yellow">
						{i18n._("Copy the password now: it won't be shown again.")}
					</Alert>
					<SimpleGrid cols={1}>
						<CopyField value={created?.name ?? ""} />
						<CopyField value={created?.password ?? ""} />
					</SimpleGrid>
					<Group justify="flex-end">
						<Button onClick={() => setCreated(null)}>{i18n._("Done")}</Button>
					</Group>
				</Stack>
			</Modal>

			<Modal
				opened={grant !== null}
				onClose={() => setGrant(null)}
				title={i18n._("Grant privileges to {user}", {
					user: grant?.name ?? "",
				})}
			>
				<Stack>
					<Select
						label={i18n._("All privileges on")}
						data={databaseOptions}
						value={grantDatabase}
						onChange={setGrantDatabase}
						error={grantMutation.fieldError("grant")}
					/>
					<Group justify="flex-end">
						<Button
							disabled={!grantDatabase}
							loading={grantMutation.isPending}
							onClick={() => grantMutation.mutate()}
						>
							{i18n._("Grant")}
						</Button>
					</Group>
				</Stack>
			</Modal>

			<ConfirmDanger
				opened={drop !== null}
				onClose={() => setDrop(null)}
				title={
					drop?.kind === "user"
						? i18n._("Drop user {name}", { name: drop?.name ?? "" })
						: i18n._("Drop database {name}", { name: drop?.name ?? "" })
				}
				description={
					drop?.kind === "user"
						? i18n._(
								"The login is removed. Apps using it can no longer connect.",
							)
						: i18n._(
								"The database and all its data are deleted (open connections are closed). This cannot be undone: back up first.",
							)
				}
				confirmName={drop?.name ?? ""}
				confirmLabel={i18n._("Drop")}
				loading={dropMutation.isPending}
				error={dropMutation.fieldError("drop")}
				onConfirm={(typed) => dropMutation.mutate(typed)}
			/>
		</Stack>
	);
};
