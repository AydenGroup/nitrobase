import type {
	CloudSyncProvider,
	CronJobMode,
	SupabaseConnectionConfig,
	SyncPart,
} from "#/config/cloud-sync.ts";
import { getConfig } from "#/config/server.ts";
import type { SupabasePluginConfig } from "#/features/supabase/schema.ts";
import { asBytes, asList, type ErrorInfo } from "#/libs/coded.ts";
import {
	rcloneCommand,
	renderRcloneSections,
} from "#/server/services/backup/rclone.ts";
import { errorInfoOf } from "#/server/services/error-info.ts";
import {
	assertFunctionFiles,
	parseTarBytes,
	readFunctionCommand,
	SHARED_DIR_PATTERN,
} from "#/server/services/supabase/edge-functions.ts";
import { quoteIdent, quoteLiteral } from "#/server/services/supabase/sql.ts";
import { AppError, coded, internalError } from "#/utils/error.ts";
import { type CloudQuery, configuredTlsMode, withCloudDb } from "./cloud-db";
import {
	BUCKET_PATTERN,
	bucketCopyArgs,
	clientImage,
	copyLogSummaryCommand,
	DUMP_DIR,
	DUMP_SERVICE,
	dataDumpCheckCommand,
	fileSizeCommand,
	findMetaCommand,
	LOAD_SECRETS_DIR,
	LOAD_SERVICE,
	LOGS_DIR,
	parseErrorLines,
	parseRowCounts,
	pgClientCommand,
	pgpassFile,
	pgServiceFile,
	RCLONE_SECRETS_DIR,
	rowCountsSql,
	SECRETS_DIR,
} from "./commands";
import { errorDetail, pinnedHost } from "./http";
import {
	appCronSide,
	appSql,
	endpoints,
	hasKeys,
	listAppFunctions,
	loadDumps,
	PLATFORM_TABLES,
	parse,
	pluginConfig,
	RESERVED_ROLE,
	resolveSource,
	type Source,
	s3Url,
} from "./supabase";
import {
	type FunctionDeploy,
	postgresMajor,
	type SupabaseApi,
	supabaseApi,
	topLevelEntries,
} from "./supabase-api";
import {
	cloudCronSide,
	copyCronJobs,
	resolveCronMode,
	verifyCronJobs,
} from "./supabase-cron";
import {
	type DumpKind,
	dumpArgs,
	EXPORT_EXCLUDED_TABLES,
	isUserSchema,
	STORAGE_OBJECTS_TABLE,
	transformRoleDump,
	transformSchemaDump,
} from "./supabase-dump";
import {
	analyzeExportPreflight,
	type CloudContents,
	cloudContentItems,
} from "./supabase-preflight";
import type {
	CloudPreflight,
	CloudSyncDriver,
	ExportSource,
	OpenedSync,
	SyncStep,
	SyncTarget,
} from "./types";

/**
 * Supabase export: a self-hosted Supabase app → an EMPTY hosted project.
 * - database: the import's dump pipeline reversed: pg_dumpall/pg_dump of
 *   the app's database (as its superuser, inside the database container's
 *   network namespace, the CLI's rules), checked for psql meta-commands,
 *   then loaded through the project's session pooler as `postgres.<ref>`
 *   (verify-full TLS) by a second client container holding only the
 *   cloud's credentials: roles → schema → replica mode → data;
 * - storage: rclone from the app's S3 protocol (its gateway on the proxy
 *   network) to the project's, per bucket. The `storage.objects` rows come
 *   with the data dump first; each upload then upserts its row (same id,
 *   new version and metadata, as Supabase Storage's S3 PutObject does),
 *   and the owners/user metadata the uploads reset are put back from a
 *   snapshot taken before (owner decision: the cloud ends up consistent:
 *   every row has its file, nothing is duplicated);
 * - edge functions: each folder's files (bytes) deployed through the
 *   Management API (`POST /functions/deploy`), with the `_shared`-style
 *   folders it imports, under the CLI's `supabase/functions/` layout;
 * - Vault secrets are never copied: replacing the project's pgsodium root
 *   key (`PUT /pgsodium`, experimental and documented as making data
 *   encrypted with the old key unreadable) is left to the owner.
 */

type Config = SupabaseConnectionConfig;

/** `select count(*)` of `table` when it exists (0 otherwise), one value. */
const countIfExists = (table: string, expression = "count(*)") =>
	`coalesce((xpath('/row/c/text()', query_to_xml(case when to_regclass('${table}') is null then 'select 0 as c' else 'select ${expression.replaceAll("'", "''")} as c from ${table}' end, false, true, '')))[1]::text, '0')`;

/** `a|b` lines of psql -A -t output. */
const rows = (output: string) =>
	output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.split("|"));

/** What the export reads from the app (before the job, and in it). */
interface LocalFacts {
	major: number | null;
	sizeBytes: number;
	/** Tables per user schema. */
	schemas: { schema: string; tables: number }[];
	buckets: number;
	objects: number;
	storageBytes: number;
	vault: number;
	/** pg_cron jobs (copied by their own step). */
	cronJobs: number;
	extensions: string[];
	roles: string[];
}

async function localFacts(target: SyncTarget): Promise<LocalFacts> {
	const failure = "CLOUD_SYNC_LOCAL_VERSION_FAILED" as const;
	const [[version = "", size = "0"] = []] = rows(
		await appSql(
			target,
			"select current_setting('server_version_num'), pg_database_size(current_database())",
			failure,
		),
	);
	const schemas = rows(
		await appSql(
			target,
			"select n.nspname, count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and not c.relispartition group by 1 order by 1",
			failure,
		),
	)
		.filter(([schema = ""]) => isUserSchema(schema))
		.map(([schema = "", tables = "0"]) => ({ schema, tables: Number(tables) }));
	const [
		[
			buckets = "0",
			objects = "0",
			storageBytes = "0",
			vault = "0",
			cronJobs = "0",
		] = [],
	] = rows(
		await appSql(
			target,
			`select ${countIfExists("storage.buckets")}, ${countIfExists("storage.objects")}, ${countIfExists("storage.objects", "sum((metadata->>'size')::bigint)")}, ${countIfExists("vault.secrets")}, ${countIfExists("cron.job")}`,
			failure,
		),
	);
	const [[extensions = ""] = []] = rows(
		await appSql(
			target,
			"select string_agg(extname, ',' order by extname) from pg_extension",
			failure,
		),
	);
	const [[roles = ""] = []] = rows(
		await appSql(
			target,
			"select string_agg(rolname, ',' order by rolname) from pg_roles where rolname !~ '^pg_'",
			failure,
		),
	);
	const number = Number(version);
	return {
		major:
			Number.isFinite(number) && number > 0
				? Math.floor(number / 10_000)
				: null,
		sizeBytes: Number(size) || 0,
		schemas,
		buckets: Number(buckets) || 0,
		objects: Number(objects) || 0,
		storageBytes: Number(storageBytes) || 0,
		vault: Number(vault) || 0,
		cronJobs: Number(cronJobs) || 0,
		extensions: extensions.split(",").filter(Boolean),
		roles: roles.split(",").filter((name) => name && !RESERVED_ROLE.test(name)),
	};
}

/** The cloud database as an export needs it (emptiness, rights, version). */
async function cloudFacts(source: Source) {
	return withCloudDb(source.db, async (query) => {
		const schemas = (
			await query<{ name: string }>("select nspname as name from pg_namespace")
		)
			.map((row) => row.name)
			.filter(isUserSchema);
		const notExtension = (catalog: string, column: string) =>
			`not exists (select 1 from pg_depend d where d.classid = '${catalog}'::regclass and d.objid = ${column} and d.deptype = 'e')`;
		const relations = (
			await query<{ name: string }>(
				`select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname = any($1) and ${notExtension("pg_class", "c.oid")} order by 1 limit 50`,
				[schemas],
			)
		).map((row) => row.name);
		const functions = (
			await query<{ name: string }>(
				`select n.nspname || '.' || p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = any($1) and ${notExtension("pg_proc", "p.oid")} order by 1 limit 50`,
				[schemas],
			)
		).map((row) => row.name);
		const count = async (table: string) =>
			Number(
				(await query<{ n: string }>(`select ${countIfExists(table)} as n`))[0]
					?.n ?? 0,
			);
		const [rights] = await query<{ ok: boolean }>(
			"select r.rolcreaterole and has_database_privilege(current_database(), 'CREATE') as ok from pg_roles r where r.rolname = current_user",
		);
		const [version] = await query<{ version: string }>(
			"select current_setting('server_version') as version",
		);
		const available = (
			await query<{ name: string }>("select name from pg_available_extensions")
		).map((row) => row.name);
		return {
			relations,
			functions,
			users: await count("auth.users"),
			buckets: await count("storage.buckets"),
			objects: await count("storage.objects"),
			vaultSecrets: await count("vault.secrets"),
			canWrite: rights?.ok === true,
			version: version?.version ?? "",
			available,
		};
	});
}

/** Everything the cloud project holds that an export would collide with. */
async function cloudContents(source: Source): Promise<{
	contents: CloudContents;
	facts: Awaited<ReturnType<typeof cloudFacts>>;
}> {
	const facts = await cloudFacts(source);
	const edgeFunctions = (await source.api.functions()).map((fn) => fn.slug);
	return {
		facts,
		contents: {
			relations: facts.relations,
			functions: facts.functions,
			users: facts.users,
			buckets: facts.buckets,
			objects: facts.objects,
			vaultSecrets: facts.vaultSecrets,
			edgeFunctions,
		},
	};
}

/** Whether the connection's database user can write (connection test). */
export async function cloudCanWrite(source: Source): Promise<boolean> {
	return withCloudDb(source.db, async (query) => {
		const [rights] = await query<{ ok: boolean }>(
			"select r.rolcreaterole and has_database_privilege(current_database(), 'CREATE') as ok from pg_roles r where r.rolname = current_user",
		);
		return rights?.ok === true;
	});
}

/** The app's functions verify JWTs (the runtime's one setting). */
function verifiesJwt(target: SyncTarget, plugin: SupabasePluginConfig) {
	const value = plugin.functions_verify_jwt
		? target.values[plugin.functions_verify_jwt]
		: undefined;
	return value?.trim().toLowerCase() !== "false";
}

/** What the export does with the app's cron jobs (`cronJobs`). */
function cronMode(source: ExportSource): CronJobMode {
	return resolveCronMode(source.inputs.cronJobs);
}

/** Writers the export stops when asked (`stopWriters`). */
function writersToStop(source: ExportSource, plugin: SupabasePluginConfig) {
	return source.inputs.stopWriters === true
		? plugin.sync_export_writer_services
		: [];
}

export async function exportPreflight(
	provider: CloudSyncProvider,
	raw: Record<string, unknown>,
	input: Parameters<CloudSyncDriver["preflight"]>[2],
	source: ExportSource,
): Promise<CloudPreflight> {
	const config = parse(provider, raw);
	const api = supabaseApi(provider, config.projectRef, config.accessToken);
	const cloud = await resolveSource(provider, config, api);
	const wants = (part: SyncPart) => input.parts.includes(part);
	const plugin = pluginConfig(source.target);
	const project = {
		id: config.projectRef,
		name: cloud.project.name,
		region: cloud.project.region,
		status: cloud.project.status,
	};
	const local = await localFacts(source.target);
	const localVersion = local.major === null ? null : String(local.major);
	const tls = configuredTlsMode(cloud.db.ca);
	if (tls === "missing") {
		return {
			direction: "export",
			project,
			versions: {
				source: cloud.project.database?.version ?? "",
				target: localVersion,
			},
			target: { ...input.target, version: localVersion },
			contents: [],
			requiredDiskBytes: 0,
			blockers: [errorInfoOf(caMissing(cloud))],
			warnings: [],
		};
	}
	const { contents, facts } = await cloudContents(cloud);
	const functions = wants("functions")
		? await listAppFunctions(source.target)
		: [];
	const stagingPrefix = getConfig().CLOUD_SYNC_EXPORT_STAGING_SCHEMA;
	const stagingTaken = rows(
		await appSql(
			source.target,
			`select nspname from pg_namespace where starts_with(nspname, ${quoteLiteral(stagingPrefix)}) order by 1`,
			"CLOUD_SYNC_LOCAL_VERSION_FAILED",
		),
	).map(([name = ""]) => name);
	const cloudVersion = cloud.project.database?.version || facts.version;
	const available = new Set(facts.available);
	const analysis = analyzeExportPreflight({
		parts: input.parts,
		localMajor: local.major,
		cloudMajor: postgresMajor(cloudVersion),
		cloud: contents,
		canWrite: facts.canWrite,
		databaseBytes: local.sizeBytes,
		freeDiskBytes: input.target.freeDiskBytes,
		diskFactor: getConfig().CLOUD_SYNC_DISK_FACTOR,
		hasStorageKeys: hasKeys(config),
		vaultSecrets: local.vault,
		extensionsMissing: local.extensions.filter((name) => !available.has(name)),
		customRoles: local.roles,
		functionCount: functions.length,
		functionsWithoutJwt: !verifiesJwt(source.target, plugin),
		stoppedWriters: writersToStop(source, plugin),
		cronJobs: local.cronJobs,
		cronMode: cronMode(source),
		tlsVerified: tls === "verify-full",
		stagingPrefix,
		stagingTaken,
	});
	const tables = local.schemas.reduce((sum, row) => sum + row.tables, 0);
	return {
		direction: "export",
		project,
		versions: { source: cloudVersion, target: localVersion },
		target: { ...input.target, version: localVersion },
		contents: [
			...(wants("database")
				? [
						{
							part: "database",
							sizeBytes: local.sizeBytes,
							counts: [{ unit: "tables" as const, count: tables }],
						},
					]
				: []),
			...(wants("storage")
				? [
						{
							part: "storage",
							sizeBytes: local.storageBytes,
							counts: [
								{ unit: "objects" as const, count: local.objects },
								{ unit: "buckets" as const, count: local.buckets },
							],
						},
					]
				: []),
			...(wants("functions")
				? [{ part: "functions", sizeBytes: null, counts: [], names: functions }]
				: []),
		],
		cloud: [
			{
				part: "database",
				sizeBytes: null,
				counts: [
					{ unit: "tables", count: contents.relations.length },
					{ unit: "users", count: contents.users },
				],
			},
			{
				part: "storage",
				sizeBytes: null,
				counts: [
					{ unit: "buckets", count: contents.buckets },
					{ unit: "objects", count: contents.objects },
				],
			},
			{
				part: "functions",
				sizeBytes: null,
				counts: [],
				names: contents.edgeFunctions,
			},
		],
		...analysis,
	};
}

function caMissing(cloud: Source): AppError {
	return new AppError("CLOUD_SYNC_CA_MISSING", { path: cloud.db.caFile });
}

/** Throw unless the cloud project is (still) empty and writable. */
async function assertCloudEmpty(cloud: Source): Promise<void> {
	if (configuredTlsMode(cloud.db.ca) === "missing") throw caMissing(cloud);
	const { contents, facts } = await cloudContents(cloud);
	const items = cloudContentItems(contents);
	if (items.length > 0) {
		throw new AppError("CLOUD_EXPORT_NOT_EMPTY", { items: asList(items) });
	}
	if (!facts.canWrite) throw new AppError("CLOUD_EXPORT_DB_READ_ONLY");
}

// ---------------------------------------------------------------------------
// Job steps

interface ExportState {
	/** User schemas of the app (row count comparison). */
	schemas: string[] | null;
	/** Whether storage.objects rows were exported (compared then). */
	objects: boolean;
	/** Functions deployed (compared with the cloud's list). */
	deployed: string[] | null;
	/** Cron jobs re-created in the cloud (null: none to compare). */
	cron: string[] | null;
	/** Tokens in the copied cron commands (redacted from the log). */
	cronSecrets: string[];
}

/** The app's pg_cron jobs, through pg_cron's API (not in the data dump). */
function cronStep(
	cloud: Source,
	state: ExportState,
	mode: CronJobMode,
): SyncStep {
	return {
		id: "cron",
		part: "database",
		run: async (run) => {
			state.cron = await withCloudDb(cloud.db, (query) =>
				copyCronJobs({
					run,
					source: appCronSide(run.target),
					target: cloudCronSide(query),
					mode,
					unnamedPrefix: getConfig().CLOUD_SYNC_CRON_UNNAMED_PREFIX,
					// Kept for the rest of the job: later lines may echo them too.
					onSecrets: (values) => state.cronSecrets.push(...values),
				}),
			).catch(async (error) => {
				await run.warn(errorInfoOf(error));
				return null;
			});
		},
	};
}

function stopWritersStep(services: string[]): SyncStep {
	return {
		id: "stop_writers",
		part: null,
		run: async ({ target, job }) => {
			job.event("cloud_sync.export_writers_stopping", {
				services: asList(services),
			});
			await target.compose(
				["stop", ...services],
				"CLOUD_SYNC_WRITERS_STOP_FAILED",
			);
			await target.servicesStopped(services);
		},
	};
}

function startWritersStep(services: string[]): SyncStep {
	return {
		id: "start_writers",
		part: null,
		run: async ({ target, job }) => {
			await target.compose(
				["up", "-d", "--no-build", ...services],
				"CLOUD_SYNC_WRITERS_START_FAILED",
			);
			await target.servicesStarted(services);
			job.event("cloud_sync.writers_started", { services: asList(services) });
		},
	};
}

function databaseStep(
	cloud: Source,
	state: ExportState,
	parts: SyncPart[],
): SyncStep {
	return {
		id: "database",
		part: "database",
		run: async (run) => {
			const { target, job } = run;
			const config = getConfig();
			const plugin = pluginConfig(target);
			const local = await localFacts(target);
			const cloudMajor = postgresMajor(cloud.project.database?.version ?? "");
			if (local.major === null || cloudMajor === null) {
				throw new AppError("CLOUD_SYNC_VERSION_UNKNOWN");
			}
			if (local.major > cloudMajor) {
				throw new AppError("CLOUD_EXPORT_POSTGRES_NEWER", {
					source: local.major,
					target: cloudMajor,
				});
			}
			const image = clientImage(config.CLOUD_SYNC_PG_CLIENT_IMAGES, cloudMajor);
			if (!image) {
				throw new AppError("CLOUD_SYNC_CLIENT_IMAGE_MISSING", {
					major: cloudMajor,
				});
			}
			job.event("cloud_sync.local_version", {
				version: local.major,
				client: image,
			});
			const ends = endpoints(cloud, target, plugin);
			// The dump container sees only the app's credentials, the load
			// container only the cloud's (and the CA bundle).
			for (const [dir, service, end] of [
				[SECRETS_DIR, LOAD_SERVICE, ends.local],
				[LOAD_SECRETS_DIR, DUMP_SERVICE, ends.cloud],
			] as const) {
				await target.executor.upload(
					pgServiceFile({ [service]: end }),
					`${target.workDir}/${dir}/pg_service.conf`,
					"0600",
				);
				await target.executor.upload(
					pgpassFile([end]),
					`${target.workDir}/${dir}/pgpass`,
					"0600",
				);
			}
			if (cloud.db.ca) {
				await target.executor.upload(
					cloud.db.ca,
					`${target.workDir}/${LOAD_SECRETS_DIR}/root.crt`,
					"0600",
				);
			}
			if (local.vault > 0) {
				await run.warn(
					coded("CLOUD_WARN_EXPORT_VAULT", { count: local.vault }),
				);
			}
			// Without the files, object rows would point at nothing.
			const objects = parts.includes("storage");
			const excludeTables = [
				...EXPORT_EXCLUDED_TABLES,
				...(objects ? [] : [STORAGE_OBJECTS_TABLE]),
			];
			const kinds: DumpKind[] = ["roles", "schema", "data"];
			const network = `container:${target.container(plugin.db_service)}`;
			for (const kind of kinds) {
				job.event("cloud_sync.export_dumping", { kind });
				const file = `/${DUMP_DIR}/${kind}.sql`;
				await target.run(
					pgClientCommand({
						image,
						workDir: target.workDir,
						mode: "dump",
						service: LOAD_SERVICE,
						network,
						argv: dumpArgs(kind, file, { excludeTables }),
					}),
					"CLOUD_SYNC_DUMP_FAILED",
					{ quiet: true },
				);
				const host = `${target.workDir}/${DUMP_DIR}/${kind}.sql`;
				if (kind === "roles" || kind === "schema") {
					const text = await target.executor.readFile(host);
					const rewritten =
						kind === "roles"
							? transformRoleDump(text)
							: transformSchemaDump(text);
					const line = findMetaCommand(rewritten);
					if (line !== null) {
						throw new AppError("CLOUD_SYNC_DUMP_UNSAFE", {
							kind,
							line: String(line),
						});
					}
					await target.executor.upload(rewritten, host, "0600");
				} else {
					await target.run(
						dataDumpCheckCommand(host),
						(detail) =>
							new AppError("CLOUD_SYNC_DUMP_UNSAFE", {
								kind,
								line: detail.trim().split("\n")[0] ?? "",
							}),
						{ quiet: true },
					);
				}
				const size = Number(
					(
						await target.run(fileSizeCommand(host), "CLOUD_SYNC_DUMP_FAILED", {
							quiet: true,
						})
					).trim(),
				);
				job.event("cloud_sync.dumped", { kind, size: asBytes(size) });
			}
			const load = async () => {
				job.event("cloud_sync.export_loading");
				await loadDumps(target, job, {
					image,
					network: config.CLOUD_SYNC_DUMP_NETWORK || "",
					files: kinds.map((kind) => `${kind}.sql`),
					service: DUMP_SERVICE,
				});
			};
			await (job.critical ? job.critical("cloud_export_data", load) : load());
			state.schemas = local.schemas.map((row) => row.schema);
			state.objects = objects;
		},
	};
}

/** Columns of storage.objects the S3 upload resets (put back afterwards). */
const OWNER_COLUMNS = ["owner", "owner_id", "user_metadata"];

/** Recovery state while the owners wait in the staging schema. */
const OWNERS_STATE = "supabase_export_owners";

/**
 * The staging schema of one export job: the configured prefix plus the
 * job's id, so two exports (or a leftover) never share one. Null when the
 * name would not be a plain identifier.
 */
export function stagingSchemaName(
	prefix: string,
	jobId: string,
): string | null {
	const id = jobId
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.slice(0, 12);
	const name = `${prefix}_${id}`;
	return id && STAGING_NAME.test(name) ? name : null;
}

const STAGING_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

const hasStagingPrefix = (name: string, prefix: string) =>
	name.startsWith(`${prefix}_`) && name.length > prefix.length + 1;

/** A staging schema name this instance could have made (recovery input). */
export function isStagingSchema(name: unknown): name is string {
	return (
		typeof name === "string" &&
		STAGING_NAME.test(name) &&
		hasStagingPrefix(name, getConfig().CLOUD_SYNC_EXPORT_STAGING_SCHEMA)
	);
}

/** Put the snapshot's owners back on the uploaded rows; drop the snapshot. */
async function restoreOwners(
	cloud: Source,
	columns: string[],
	schema: string,
): Promise<void> {
	const staging = quoteIdent(schema);
	const known = columns.filter((name) => OWNER_COLUMNS.includes(name));
	await withCloudDb(cloud.db, async (query: CloudQuery) => {
		const [exists] = await query<{ ok: boolean }>(
			"select to_regclass($1) is not null as ok",
			[`${staging}.objects`],
		);
		if (exists?.ok && known.length > 0) {
			await query(
				`update storage.objects o set ${known
					.map((name) => `${quoteIdent(name)} = s.${quoteIdent(name)}`)
					.join(", ")} from ${staging}.objects s where o.id = s.id`,
			);
		}
		await query(`drop schema if exists ${staging} cascade`);
	});
}

/**
 * After a panel restart killed an export while files uploaded: put the
 * owners back and drop the snapshot (with the connection's credentials).
 */
export async function recoverExport(input: {
	state: unknown;
	connection?: { provider: CloudSyncProvider; config: Record<string, unknown> };
}): Promise<void> {
	const state = input.state as {
		kind?: unknown;
		columns?: unknown;
		schema?: unknown;
	} | null;
	if (state?.kind !== OWNERS_STATE || !input.connection) return;
	// Only a schema this export made is ever dropped.
	if (!isStagingSchema(state.schema)) return;
	const schema = state.schema;
	const columns = Array.isArray(state.columns)
		? state.columns.filter((name): name is string => typeof name === "string")
		: [];
	const config = parse(input.connection.provider, input.connection.config);
	const api = supabaseApi(
		input.connection.provider,
		config.projectRef,
		config.accessToken,
	);
	await restoreOwners(
		await resolveSource(input.connection.provider, config, api),
		columns,
		schema,
	);
}

function storageStep(
	provider: CloudSyncProvider,
	config: Config,
	cloud: Source,
	state: ExportState,
): SyncStep {
	return {
		id: "storage",
		part: "storage",
		run: async (run) => {
			const { target, job } = run;
			if (!hasKeys(config)) throw new AppError("CLOUD_EXPORT_STORAGE_NO_KEYS");
			const plugin = pluginConfig(target);
			const settings = getConfig();
			const buckets = rows(
				await appSql(
					target,
					"select b.id, count(o.id) from storage.buckets b left join storage.objects o on o.bucket_id = b.id group by b.id order by b.id",
					"CLOUD_SYNC_VERIFY_FAILED",
				),
			).map(([bucket = "", objects = "0"]) => ({
				bucket,
				objects: Number(objects),
			}));
			const value = (name: string | undefined) =>
				name ? (target.values[name] ?? "") : "";
			const s3 = (section: {
				endpoint: string;
				region: string;
				id: string;
				secret: string;
			}) => ({
				type: "s3",
				provider: "Other",
				endpoint: section.endpoint,
				region: section.region,
				access_key_id: section.id,
				secret_access_key: section.secret,
				force_path_style: "true",
				no_check_bucket: "true",
			});
			await pinnedHost(provider, new URL(s3Url(config.projectRef)).hostname);
			const confPath = `${target.workDir}/${RCLONE_SECRETS_DIR}/rclone.conf`;
			await target.executor.upload(
				renderRcloneSections({
					cloud: s3({
						endpoint: s3Url(config.projectRef),
						region: cloud.project.region,
						id: config.s3AccessKeyId,
						secret: config.s3SecretAccessKey,
					}),
					local: s3({
						endpoint: `http://${target.container(plugin.api_service)}:${plugin.api_port}${plugin.storage_s3_path ?? ""}`,
						region: value(plugin.storage_region),
						id: value(plugin.storage_s3_key_id),
						secret: value(plugin.storage_s3_key_secret),
					}),
				}),
				confPath,
				"0600",
			);
			const schema = stagingSchemaName(
				settings.CLOUD_SYNC_EXPORT_STAGING_SCHEMA,
				job.deploymentId,
			);
			if (!schema) {
				throw internalError(`Invalid staging schema for ${job.deploymentId}`);
			}
			const staging = quoteIdent(schema);
			// Uploads upsert their rows as the S3 caller: keep the owners.
			const columns = await withCloudDb(cloud.db, (query) =>
				query<{ name: string }>(
					"select column_name as name from information_schema.columns where table_schema = 'storage' and table_name = 'objects' and column_name = any($1)",
					[OWNER_COLUMNS],
				),
			).then((list) => list.map((row) => row.name));
			const restore = state.objects && columns.length > 0;
			if (restore) {
				// Recorded first: a crash from here on, recovery puts the
				// owners back and drops exactly this schema.
				await run.checkpoint?.({ kind: OWNERS_STATE, columns, schema });
				await withCloudDb(cloud.db, async (query) => {
					await query(`create schema ${staging}`);
					await query(
						`create table ${staging}.objects as select id, ${columns.map(quoteIdent).join(", ")} from storage.objects`,
					);
				});
			}
			run.summary.buckets = [];
			try {
				for (const row of buckets) {
					if (!BUCKET_PATTERN.test(row.bucket)) {
						await run.warn(
							coded("CLOUD_WARN_BUCKET_SKIPPED", { bucket: row.bucket }),
						);
						continue;
					}
					job.event("cloud_sync.bucket", {
						bucket: row.bucket,
						objects: row.objects,
					});
					const logName = `rclone-${row.bucket}.log`;
					const failure = (detail: string) =>
						new AppError("CLOUD_SYNC_STORAGE_FAILED", {
							bucket: row.bucket,
							detail,
						});
					let failed: unknown = null;
					try {
						await target.run(
							rcloneCommand({
								image: settings.RCLONE_IMAGE,
								confPath,
								remote: { section: {}, base: "" },
								workDir: `${target.workDir}/${LOGS_DIR}`,
								network: settings.NITROBASE_NETWORK,
								args: bucketCopyArgs(
									row.bucket,
									settings.CLOUD_SYNC_RCLONE_TRANSFERS,
									`/work/${logName}`,
									{ from: "local", to: "cloud" },
								),
							}),
							failure,
							{ quiet: true },
						);
					} catch (error) {
						failed = error;
					}
					const copy = parseErrorLines(
						await target.run(
							copyLogSummaryCommand(
								`${target.workDir}/${LOGS_DIR}/${logName}`,
								10,
							),
							failure,
							{ quiet: true },
						),
					);
					job.event("cloud_sync.bucket_done", {
						bucket: row.bucket,
						copied: copy.count,
					});
					run.summary.buckets.push({
						bucket: row.bucket,
						source: row.objects,
						target: copy.count,
					});
					if (failed) {
						await run.warn(
							coded("CLOUD_SYNC_STORAGE_FAILED", {
								bucket: row.bucket,
								detail: copy.lines.join("\n") || errorDetail(failed),
							}),
						);
					}
				}
			} finally {
				if (restore) {
					await restoreOwners(cloud, columns, schema);
					await run.checkpoint?.(null);
				}
			}
		},
	};
}

/** Folders a function imports (`../_shared/x.ts`), from its text files. */
export function sharedImports(files: { path: string; content: Buffer }[]) {
	const found = new Set<string>();
	for (const file of files) {
		const text = file.content.toString("utf8");
		for (const match of text.matchAll(/\.\.\/(_[a-z0-9][a-z0-9_-]*)\//g)) {
			if (match[1] && SHARED_DIR_PATTERN.test(match[1])) found.add(match[1]);
		}
	}
	return [...found].sort();
}

/** The deploy of one function folder (pure: picks entrypoint/import map). */
export function functionDeploy(
	plugin: SupabasePluginConfig,
	input: {
		slug: string;
		files: { path: string; content: Buffer }[];
		shared: Record<string, { path: string; content: Buffer }[]>;
		verifyJwt: boolean;
	},
): FunctionDeploy {
	const paths = new Set(input.files.map((file) => file.path));
	const entrypoint = plugin.functions_entrypoints.find((name) =>
		paths.has(name),
	);
	if (!entrypoint) {
		throw new AppError("CLOUD_SYNC_FUNCTION_NO_ENTRYPOINT", {
			name: input.slug,
			expected: asList(plugin.functions_entrypoints),
			found: asList(topLevelEntries(input.files.map((file) => file.path))),
		});
	}
	return {
		slug: input.slug,
		entrypoint,
		importMap:
			plugin.functions_import_maps.find((name) => paths.has(name)) ?? null,
		verifyJwt: input.verifyJwt,
		files: input.files,
		shared: input.shared,
	};
}

function functionsStep(api: SupabaseApi, state: ExportState): SyncStep {
	return {
		id: "functions",
		part: "functions",
		run: async (run) => {
			const { target, job } = run;
			const settings = getConfig();
			const plugin = pluginConfig(target);
			const limits = {
				maxFiles: settings.SUPABASE_FUNCTION_MAX_FILES,
				maxBytes: settings.SUPABASE_FUNCTION_MAX_BYTES,
			};
			const container = target.container(plugin.functions_service);
			const read = async (name: string, shared: boolean) => {
				const encoded = await target.run(
					readFunctionCommand(container, plugin.functions_dir, name, {
						shared,
					}),
					(detail) =>
						new AppError("CLOUD_SYNC_FUNCTION_READ_FAILED", { name, detail }),
					{ quiet: true },
				);
				const parsed = parseTarBytes(
					Buffer.from(encoded.replace(/\s+/g, ""), "base64"),
					limits,
				);
				return parsed.files;
			};
			const names = await listAppFunctions(target);
			run.summary.functions = [];
			state.deployed = [];
			if (names.length === 0) return;
			await run.warn(coded("CLOUD_WARN_EXPORT_FUNCTION_SECRETS"));
			const verifyJwt = verifiesJwt(target, plugin);
			const sharedCache = new Map<
				string,
				{ path: string; content: Buffer }[]
			>();
			for (const slug of names) {
				try {
					const files = await read(slug, false);
					const shared: Record<string, { path: string; content: Buffer }[]> =
						{};
					for (const dir of sharedImports(files)) {
						if (!sharedCache.has(dir)) {
							sharedCache.set(dir, await read(dir, true).catch(() => []));
						}
						const content = sharedCache.get(dir) ?? [];
						if (content.length) shared[dir] = content;
					}
					assertFunctionFiles(
						[
							...files,
							...Object.entries(shared).flatMap(([dir, list]) =>
								list.map((file) => ({ ...file, path: `${dir}/${file.path}` })),
							),
						],
						limits,
					);
					await api.deployFunction(
						functionDeploy(plugin, { slug, files, shared, verifyJwt }),
					);
					job.event("cloud_sync.function_deployed", {
						name: slug,
						files: files.length,
					});
					run.summary.functions.push({ slug, ok: true });
					state.deployed.push(slug);
				} catch (error) {
					job.event("cloud_sync.function_skipped", {
						name: slug,
						reason: { $error: errorInfoOf(error) },
					});
					await job.addWarnings?.(1);
					run.summary.functions.push({ slug, ok: false });
				}
			}
		},
	};
}

function verifyStep(
	cloud: Source,
	api: SupabaseApi,
	state: ExportState,
): SyncStep {
	return {
		id: "verify",
		part: null,
		run: async (run) => {
			const { target, job } = run;
			const limit = getConfig().CLOUD_SYNC_VERIFY_MAX_TABLES;
			if (state.schemas) {
				const platform = PLATFORM_TABLES.filter(
					(table) => state.objects || table !== STORAGE_OBJECTS_TABLE,
				);
				const sql = rowCountsSql(state.schemas, platform, limit);
				const local = parseRowCounts(
					await appSql(target, sql, "CLOUD_SYNC_VERIFY_FAILED"),
				);
				const remote = new Map(
					(
						await withCloudDb(cloud.db, (query) =>
							query<{ t: string; n: string }>(sql),
						)
					).map((row) => [row.t, Number(row.n)]),
				);
				const tables = [...local].map(([table, rows]) => ({
					table,
					source: rows,
					target: remote.get(table) ?? 0,
				}));
				run.summary.tables = tables;
				const mismatches = tables.filter((row) => row.source !== row.target);
				for (const row of mismatches.slice(0, 50)) {
					job.event("cloud_sync.export_row_mismatch", row);
				}
				if (mismatches.length) await job.addWarnings?.(mismatches.length);
				job.event("cloud_sync.verified", {
					tables: tables.length,
					mismatches: mismatches.length,
				});
			}
			if (state.deployed && run.summary.functions) {
				const present = new Set((await api.functions()).map((fn) => fn.slug));
				run.summary.functions = run.summary.functions.map((fn) => ({
					...fn,
					ok: fn.ok && present.has(fn.slug),
				}));
			}
			if (state.cron?.length) {
				const expected = state.cron;
				await withCloudDb(cloud.db, (query) =>
					verifyCronJobs(run, cloudCronSide(query), expected),
				).catch((error) => run.warn(errorInfoOf(error)));
			}
			run.summary.notes = [
				...(run.summary.notes ?? []),
				{
					code: "CLOUD_NOTE_EXPORT_SUPABASE_NEXT",
					params: { project: cloud.project.ref },
				},
			];
		},
	};
}

export async function openExport(
	provider: CloudSyncProvider,
	raw: Record<string, unknown>,
	source: ExportSource,
): Promise<OpenedSync> {
	const config = parse(provider, raw);
	const api = supabaseApi(provider, config.projectRef, config.accessToken);
	const cloud = await resolveSource(provider, config, api);
	const status = cloud.project.status;
	if (!/^ACTIVE_/.test(status)) {
		throw new AppError("CLOUD_PROJECT_NOT_READY", { status });
	}
	const state: ExportState = {
		schemas: null,
		objects: false,
		deployed: null,
		cron: null,
		cronSecrets: [],
	};
	const plugin = pluginConfig(source.target);
	const writers = writersToStop(source, plugin);
	const cron = cronMode(source);
	return {
		project: config.projectRef,
		region: cloud.project.region,
		version: cloud.project.database?.version ?? "",
		secrets: () => [...state.cronSecrets],
		prepare: async () => undefined,
		assertEmpty: () => assertCloudEmpty(cloud),
		steps: (parts) => [
			...(writers.length ? [stopWritersStep(writers)] : []),
			...(parts.includes("database")
				? [databaseStep(cloud, state, parts), cronStep(cloud, state, cron)]
				: []),
			...(parts.includes("storage")
				? [storageStep(provider, config, cloud, state)]
				: []),
			...(parts.includes("functions") ? [functionsStep(api, state)] : []),
			...(writers.length ? [startWritersStep(writers)] : []),
			verifyStep(cloud, api, state),
		],
	};
}

/** Per-direction capability of a tested connection (`test` result). */
export function exportCapability(input: {
	databaseOk: boolean;
	databaseError: ErrorInfo | null;
	canWrite: boolean | null;
}): { ok: boolean; reason?: ErrorInfo | null } {
	if (!input.databaseOk) return { ok: false, reason: input.databaseError };
	if (input.canWrite === false) {
		return { ok: false, reason: coded("CLOUD_EXPORT_DB_READ_ONLY") };
	}
	return { ok: true };
}
