import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Checkbox,
	Code,
	Drawer,
	Group,
	JsonInput,
	List,
	Modal,
	ScrollArea,
	SegmentedControl,
	Select,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Database,
	Pencil,
	Play,
	Plus,
	ShieldAlert,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { useCan } from "#/components/teams/useCan";
import { CodeEditor } from "#/components/ui/CodeEditor";
import { ConfirmDanger } from "#/components/ui/ConfirmDanger";
import { type DataColumn, DataTable } from "#/components/ui/DataTable";
import { EmptyState } from "#/components/ui/EmptyState";
import { SectionCard } from "#/components/ui/SectionCard";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { sqlRiskLabels } from "#/config/sql-risks.ts";
import type {
	DbFunctionSummary,
	HttpResult,
	SqlResult,
} from "#/features/supabase/schema.ts";
import { analyzeSqlRisk } from "#/features/supabase/sql-guard.ts";
import {
	applyDbSqlFn,
	dropDbFunctionFn,
	getDbFunctionDefinitionFn,
	getNewDbFunctionSqlFn,
	runRpcFn,
} from "#/features/supabase/supabase.functions.ts";
import {
	dbFunctionsQueryOptions,
	dbSchemasQueryOptions,
	supabaseOverviewQueryOptions,
} from "#/features/supabase/supabase.query.ts";
import type { PluginTabProps } from "#/plugins/types.ts";
import { internalError } from "#/utils/error.ts";
import { HttpResultView } from "./HttpResultView";

const DEFAULT_SCHEMA = "public";

/** `{"a": null, …}` from identity args like `a text, b integer DEFAULT 1`. */
function argsTemplate(args: string): string {
	const names = args
		.split(",")
		.map((part) => part.trim().split(/\s+/))
		.filter(
			(tokens) =>
				tokens.length >= 2 &&
				!["IN", "OUT", "INOUT", "VARIADIC"].includes(tokens[0].toUpperCase()),
		)
		.map((tokens) => tokens[0].replace(/^"|"$/g, ""));
	return JSON.stringify(
		Object.fromEntries(names.map((name) => [name, null])),
		null,
		2,
	);
}

export default function DbFunctionsTab({ overview }: PluginTabProps) {
	const { i18n } = useLingui();
	const appId = overview.app.id;
	const queryClient = useQueryClient();
	const plugin = useQuery(supabaseOverviewQueryOptions(appId));
	const deployed =
		!!plugin.data && overview.services.includes(plugin.data.dbService);
	const schemas = useQuery({
		...dbSchemasQueryOptions(appId),
		enabled: deployed,
	});
	const [schema, setSchema] = useState(DEFAULT_SCHEMA);
	const functions = useQuery({
		...dbFunctionsQueryOptions(appId, schema),
		enabled: deployed,
	});
	const [editor, setEditor] = useState<{
		title: string;
		sql: string;
		readOnly: boolean;
	} | null>(null);
	const [dropping, setDropping] = useState<DbFunctionSummary | null>(null);
	const [rpc, setRpc] = useState<DbFunctionSummary | null>(null);

	const refresh = () =>
		queryClient.invalidateQueries({
			queryKey: dbFunctionsQueryOptions(appId, schema).queryKey,
		});

	const readOnly =
		schemas.data?.find((item) => item.name === schema)?.readOnly ?? false;
	// Browsing needs `app.view`; changing anything needs `app.database`
	// (the server checks it too; this only hides what would be refused).
	const can = useCan();
	const canWrite = can("app.database");
	const managedSchemas = (schemas.data ?? [])
		.filter((item) => item.readOnly)
		.map((item) => item.name);

	const openDefinition = useAppMutation({
		mutationFn: async (fn: DbFunctionSummary) => ({
			fn,
			sql: await getDbFunctionDefinitionFn({
				data: { appId, schema: fn.schema, oid: fn.oid },
			}),
		}),
		onSuccess: ({ fn, sql }) =>
			setEditor({
				title: `${fn.schema}.${fn.name}(${fn.args})`,
				sql,
				readOnly: readOnly || !canWrite,
			}),
	});

	const openNew = useAppMutation({
		mutationFn: async () =>
			await getNewDbFunctionSqlFn({ data: { appId, schema } }),
		onSuccess: (sql) =>
			setEditor({ title: i18n._("New function"), sql, readOnly: false }),
	});

	const drop = useAppMutation({
		mutationFn: async (fn: DbFunctionSummary) =>
			await dropDbFunctionFn({
				data: { appId, schema: fn.schema, oid: fn.oid },
			}),
		success: (result) => (result.ok ? i18n._("Function dropped") : null),
		onSuccess: (result) => {
			if (result.ok) {
				setDropping(null);
				refresh();
			}
		},
	});

	if (plugin.error) return <Alert color="red">{plugin.error.message}</Alert>;
	if (!plugin.data) return null;
	if (!deployed) {
		return (
			<EmptyState
				icon={Database}
				title={i18n._("Not deployed yet")}
				description={i18n._(
					"Database Functions are available after the first deploy.",
				)}
			/>
		);
	}

	const columns: DataColumn<DbFunctionSummary>[] = [
		{
			key: "name",
			header: i18n._("Name"),
			sortValue: (row) => row.name,
			render: (row) => (
				<Stack gap={0}>
					<Group gap={6}>
						<Text size="sm" ff="monospace" fw={500}>
							{row.name}
						</Text>
						{row.kind === "p" && (
							<Badge size="xs" variant="light">
								{i18n._("procedure")}
							</Badge>
						)}
						{row.security_definer && (
							<Badge size="xs" variant="light" color="orange">
								security definer
							</Badge>
						)}
					</Group>
					<Text size="xs" c="dimmed" ff="monospace">
						({row.args})
					</Text>
				</Stack>
			),
		},
		{
			key: "returns",
			header: i18n._("Returns"),
			hideOnMobile: true,
			render: (row) => (
				<Text size="sm" ff="monospace">
					{row.returns || "—"}
				</Text>
			),
		},
		{
			key: "language",
			header: i18n._("Language"),
			hideOnMobile: true,
			sortValue: (row) => row.language,
			render: (row) => row.language,
		},
		{
			key: "actions",
			header: "",
			align: "right",
			render: (row) => (
				<Group gap={4} justify="flex-end" wrap="nowrap">
					<Tooltip
						label={
							readOnly || !canWrite
								? i18n._("View definition")
								: i18n._("View / edit definition")
						}
					>
						<ActionIcon
							variant="subtle"
							aria-label={i18n._("View / edit definition")}
							loading={
								openDefinition.isPending &&
								openDefinition.variables?.oid === row.oid
							}
							onClick={() => openDefinition.mutate(row)}
						>
							<Pencil size={14} />
						</ActionIcon>
					</Tooltip>
					{row.kind === "f" && canWrite && (
						<Tooltip label={i18n._("Run RPC")}>
							<ActionIcon
								variant="subtle"
								aria-label={i18n._("Run RPC")}
								onClick={() => setRpc(row)}
							>
								<Play size={14} />
							</ActionIcon>
						</Tooltip>
					)}
					{!readOnly && canWrite && (
						<Tooltip label={i18n._("Drop")}>
							<ActionIcon
								variant="subtle"
								color="red"
								aria-label={i18n._("Drop")}
								onClick={() => setDropping(row)}
							>
								<Trash2 size={14} />
							</ActionIcon>
						</Tooltip>
					)}
				</Group>
			),
		},
	];

	return (
		<Stack gap="md">
			<Alert
				color="orange"
				icon={<ShieldAlert size={18} />}
				title={i18n._("Runs SQL as a database superuser")}
			>
				{i18n._(
					"Statements here run in the db container as a superuser and bypass Row Level Security. A superuser can also run programs inside the db container (e.g. COPY … TO PROGRAM). Every change is recorded in the audit log.",
				)}
			</Alert>
			<SectionCard
				flush
				title={i18n._("Database functions")}
				actions={
					<>
						<Select
							aria-label={i18n._("Schema")}
							size="xs"
							w={180}
							data={(
								schemas.data ?? [{ name: DEFAULT_SCHEMA, readOnly: false }]
							).map((item) => ({
								value: item.name,
								label: item.readOnly
									? i18n._("{schema} (read-only)", { schema: item.name })
									: item.name,
							}))}
							value={schema}
							onChange={(value) => value && setSchema(value)}
							allowDeselect={false}
							searchable
						/>
						{canWrite && (
							<Button
								size="xs"
								leftSection={<Plus size={14} />}
								disabled={readOnly}
								title={
									readOnly
										? i18n._("This schema is managed by the template")
										: undefined
								}
								loading={openNew.isPending}
								onClick={() => openNew.mutate()}
							>
								{i18n._("New function")}
							</Button>
						)}
					</>
				}
			>
				{functions.error ? (
					<Alert color="red" m="md">
						{functions.error.message}
					</Alert>
				) : (
					<DataTable
						columns={columns}
						rows={functions.data ?? []}
						getRowKey={(row) => String(row.oid)}
						loading={functions.isLoading}
						defaultSort={{ key: "name", direction: "asc" }}
						empty={
							<Text size="sm" c="dimmed" p="md">
								{i18n._("No functions in schema {schema}.", { schema })}
							</Text>
						}
					/>
				)}
			</SectionCard>

			<SqlEditorDrawer
				appId={appId}
				state={editor}
				managedSchemas={managedSchemas}
				onClose={() => setEditor(null)}
				onApplied={refresh}
			/>
			<RpcModal appId={appId} fn={rpc} onClose={() => setRpc(null)} />
			<ConfirmDanger
				opened={dropping !== null}
				onClose={() => setDropping(null)}
				title={i18n._("Drop function")}
				description={
					<>
						{i18n._(
							"The function is dropped from the database. Anything calling it will fail.",
						)}{" "}
						<Code>
							{dropping
								? `${dropping.schema}.${dropping.name}(${dropping.args})`
								: ""}
						</Code>
					</>
				}
				confirmName={dropping?.name ?? ""}
				confirmLabel={i18n._("Drop")}
				loading={drop.isPending}
				error={
					drop.data && !drop.data.ok
						? (drop.data.error ?? undefined)
						: undefined
				}
				onConfirm={() => dropping && drop.mutate(dropping)}
			/>
		</Stack>
	);
}

function SqlEditorDrawer({
	appId,
	state,
	managedSchemas,
	onClose,
	onApplied,
}: {
	appId: string;
	state: { title: string; sql: string; readOnly: boolean } | null;
	/** Schemas the template manages (changing their objects needs a confirmation). */
	managedSchemas: string[];
	onClose: () => void;
	onApplied: () => void;
}) {
	const { i18n } = useLingui();
	const [sql, setSql] = useState<string | null>(null);
	const [result, setResult] = useState<SqlResult | null>(null);
	// The SQL text the user confirmed: editing it takes the confirmation back.
	const [confirmedSql, setConfirmedSql] = useState<string | null>(null);
	const current = sql ?? state?.sql ?? "";
	const risks = state?.readOnly ? [] : analyzeSqlRisk(current, managedSchemas);
	const confirmed = risks.length > 0 && confirmedSql === current;
	const apply = useAppMutation({
		mutationFn: async () =>
			await applyDbSqlFn({
				data: {
					appId,
					sql: current,
					acknowledgeRisk: confirmed ? true : undefined,
				},
			}),
		success: (next) => (next.ok ? i18n._("SQL applied") : null),
		// Refusals (e.g. meta-commands) show inline like SQL errors.
		field: "sql",
		onMutate: () => setResult(null),
		onSuccess: (next) => {
			setResult(next);
			if (next.ok) onApplied();
		},
	});
	const error = result?.error ?? apply.fieldError();
	const close = () => {
		setSql(null);
		setResult(null);
		setConfirmedSql(null);
		apply.clearFieldError();
		onClose();
	};
	return (
		<Drawer
			opened={state !== null}
			onClose={close}
			title={state?.title}
			position="right"
			size="xl"
		>
			<Stack gap="sm">
				<Text size="sm" c="dimmed">
					{i18n._(
						"Use CREATE OR REPLACE FUNCTION to change a function. The statements run in one transaction: on error nothing is applied.",
					)}
				</Text>
				<CodeEditor
					label={i18n._("SQL")}
					value={current}
					onChange={setSql}
					language="pgsql"
					readOnly={state?.readOnly}
					height="55vh"
				/>
				{risks.length > 0 && (
					<Alert
						color="red"
						icon={<ShieldAlert size={18} />}
						title={i18n._("This statement can break the app")}
					>
						<Stack gap="xs">
							<List size="sm">
								{risks.map((risk) => (
									<List.Item key={risk}>
										{i18n._(sqlRiskLabels[risk])}
									</List.Item>
								))}
							</List>
							<Checkbox
								label={i18n._("I understand and want to run it")}
								checked={confirmed}
								onChange={(event) =>
									setConfirmedSql(event.currentTarget.checked ? current : null)
								}
							/>
						</Stack>
					</Alert>
				)}
				{error && (
					<Alert color="red" title={i18n._("SQL error")}>
						<Text size="sm" ff="monospace" style={{ whiteSpace: "pre-wrap" }}>
							{error}
						</Text>
					</Alert>
				)}
				{result?.ok && result.output.trim() && (
					<ScrollArea.Autosize mah={160}>
						<Code block>{result.output}</Code>
					</ScrollArea.Autosize>
				)}
				<Group justify="flex-end">
					<Button variant="default" onClick={close}>
						{i18n._("Close")}
					</Button>
					{!state?.readOnly && (
						<Button
							color="orange"
							loading={apply.isPending}
							disabled={!current.trim() || (risks.length > 0 && !confirmed)}
							onClick={() => apply.mutate()}
						>
							{i18n._("Run as superuser")}
						</Button>
					)}
				</Group>
			</Stack>
		</Drawer>
	);
}

function RpcModal({
	appId,
	fn,
	onClose,
}: {
	appId: string;
	fn: DbFunctionSummary | null;
	onClose: () => void;
}) {
	const { i18n } = useLingui();
	const [args, setArgs] = useState<string | null>(null);
	const [key, setKey] = useState<"anon" | "service">("anon");
	const [result, setResult] = useState<HttpResult | null>(null);
	const current = args ?? (fn ? argsTemplate(fn.args) : "{}");
	const run = useAppMutation({
		mutationFn: async () => {
			if (!fn) throw internalError("No function");
			return await runRpcFn({
				data: { appId, schema: fn.schema, name: fn.name, args: current, key },
			});
		},
		onSuccess: setResult,
	});
	const close = () => {
		setArgs(null);
		setResult(null);
		onClose();
	};
	return (
		<Modal
			opened={fn !== null}
			onClose={close}
			title={fn ? `rpc/${fn.name}` : ""}
			size="lg"
			centered
		>
			<Stack gap="sm">
				<Text size="sm" c="dimmed">
					{i18n._(
						"POST /rest/v1/rpc/{name} through the API gateway (PostgREST). The schema must be exposed by the API.",
						{ name: fn?.name ?? "" },
					)}
				</Text>
				<JsonInput
					label={i18n._("Arguments (JSON object)")}
					value={current}
					onChange={setArgs}
					validationError={i18n._("Invalid JSON")}
					formatOnBlur
					autosize
					minRows={3}
					maxRows={12}
				/>
				<Group align="flex-end" justify="space-between">
					<SegmentedControl
						value={key}
						onChange={(value) => setKey(value as "anon" | "service")}
						data={[
							{ value: "anon", label: "anon" },
							{ value: "service", label: "service_role" },
						]}
					/>
					<Button
						leftSection={<Play size={16} />}
						loading={run.isPending}
						onClick={() => run.mutate()}
					>
						{i18n._("Run")}
					</Button>
				</Group>
				{result && <HttpResultView result={result} />}
			</Stack>
		</Modal>
	);
}
