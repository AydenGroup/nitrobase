import { randomBytes } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type {
	CloudSyncProvider,
	CronJobMode,
	SupabaseConnectionConfig,
	SyncDirection,
	SyncPart,
} from "#/config/cloud-sync.ts";
import { getConfig } from "#/config/server.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import type { CloudConnectionTestRecord } from "#/db/schema/cloud-sync.ts";
import {
	type SupabasePluginConfig,
	SupabasePluginConfigSchema,
} from "#/features/supabase/schema.ts";
import { backupDatabaseService } from "#/features/templates/schema.ts";
import { asBytes, asList, type ErrorInfo } from "#/libs/coded.ts";
import { clip } from "#/libs/format.ts";
import {
	rcloneCommand,
	renderRcloneSections,
} from "#/server/services/backup/rclone.ts";
import { errorInfoOf } from "#/server/services/error-info.ts";
import {
	assertFunctionFiles,
	buildTar,
	cleanupStagingCommand,
	deployFunctionScript,
	type FunctionFile,
	listFunctionsCommand,
	parseFunctionList,
	STAGING_PREFIX,
} from "#/server/services/supabase/edge-functions.ts";
import { psqlCommand } from "#/server/services/supabase/sql.ts";
import { AppError, coded, commandError, internalError } from "#/utils/error.ts";
import {
	type CloudDbTarget,
	caBundle,
	caMissingError,
	configuredTlsMode,
	withCloudDb,
} from "./cloud-db";
import {
	BUCKET_PATTERN,
	bucketCopyArgs,
	clientImage,
	copyLogSummaryCommand,
	DUMP_DIR,
	DUMP_SERVICE,
	dataDumpCheckCommand,
	EXPECTED_LOAD_ERRORS,
	errorLinesCommand,
	fileSizeCommand,
	findMetaCommand,
	LOAD_SECRETS_DIR,
	LOAD_SERVICE,
	LOGS_DIR,
	type PgEndpoint,
	parseErrorLines,
	parseRowCounts,
	pgClientCommand,
	pgpassFile,
	pgServiceFile,
	RCLONE_SECRETS_DIR,
	restoreArgv,
	rowCountsSql,
	SECRETS_DIR,
	writeContainerFileCommand,
} from "./commands";
import { cloudRequest, errorDetail, pinnedHost } from "./http";
import { parseBucketNames, signS3Request } from "./sigv4";
import {
	assertFunctionEntrypoint,
	postgresMajor,
	type SupabaseApi,
	type SupabaseFunction,
	supabaseApi,
} from "./supabase-api";
import {
	type CronSide,
	cloudCronSide,
	copyCronJobs,
	resolveCronMode,
	verifyCronJobs,
} from "./supabase-cron";
import {
	type DumpKind,
	dumpArgs,
	isUserSchema,
	RESERVED_ROLES,
	transformRoleDump,
	transformSchemaDump,
} from "./supabase-dump";
import {
	cloudCanWrite,
	exportCapability,
	exportPreflight,
	openExport,
	recoverExport,
} from "./supabase-export";
import { analyzePreflight, imageMajor } from "./supabase-preflight";
import type {
	CloudPreflight,
	CloudSyncDriver,
	ExportSource,
	OpenedSync,
	StepFailure,
	SyncRun,
	SyncStep,
	SyncTarget,
	TemplateProbe,
} from "./types";

/**
 * Supabase driver: a hosted project → a new self-hosted Supabase app.
 * - database: pg_dumpall/pg_dump through the project's session pooler in a
 *   Postgres client container on the server (the CLI's roles/schema/data
 *   split, #/server/services/cloud-sync/supabase-dump.ts), loaded by the
 *   same image inside the app database container's network namespace, so
 *   psql meta-commands can only ever run in that throwaway container;
 * - storage: rclone S3 → S3 per bucket (the app's S3 protocol behind its
 *   gateway on the proxy network);
 * - edge functions: source files from the Management API (multipart),
 *   written like the Edge Functions tab does.
 */

type Config = SupabaseConnectionConfig;

/** Tables compared on top of the user schemas. */
export const PLATFORM_TABLES = [
	"auth.users",
	"auth.identities",
	"storage.buckets",
	"storage.objects",
];

export const parse = (
	provider: CloudSyncProvider,
	raw: Record<string, unknown>,
) => provider.schema.parse(raw) as Config;

export const s3Url = (ref: string) =>
	getConfig().CLOUD_SYNC_SUPABASE_S3_URL.replaceAll("{ref}", ref);

export interface Source {
	api: SupabaseApi;
	db: CloudDbTarget;
	project: Awaited<ReturnType<SupabaseApi["project"]>>;
}

export async function resolveSource(
	provider: CloudSyncProvider,
	config: Config,
	api: SupabaseApi,
	project?: Source["project"],
): Promise<Source> {
	const resolved = project ?? (await api.project());
	const pooler = config.poolerHost
		? {
				db_host: config.poolerHost,
				db_port: 5432,
				db_user: `postgres.${config.projectRef}`,
				db_name: "postgres",
			}
		: await api.pooler();
	const address = await pinnedHost(provider, pooler.db_host);
	return {
		api,
		project: resolved,
		db: {
			host: pooler.db_host,
			address,
			port: pooler.db_port,
			user: pooler.db_user,
			password: config.dbPassword,
			database: pooler.db_name,
			ca: caBundle(
				config.caCertificate,
				getConfig().CLOUD_SYNC_SUPABASE_CA_FILE,
			),
			caFile: getConfig().CLOUD_SYNC_SUPABASE_CA_FILE,
		},
	};
}

async function listBuckets(
	provider: CloudSyncProvider,
	config: Config,
	region: string,
): Promise<string[]> {
	const endpoint = new URL(`${s3Url(config.projectRef).replace(/\/+$/, "")}/`);
	const response = await cloudRequest(provider, {
		url: endpoint.toString(),
		headers: signS3Request({
			method: "GET",
			url: endpoint,
			region,
			accessKeyId: config.s3AccessKeyId,
			secretAccessKey: config.s3SecretAccessKey,
		}),
	}).catch((error) => {
		throw new AppError("CLOUD_S3_FAILED", { detail: errorDetail(error) });
	});
	return parseBucketNames(response.body.toString("utf8"));
}

export const hasKeys = (config: Config) =>
	!!config.s3AccessKeyId && !!config.s3SecretAccessKey;

async function test(
	provider: CloudSyncProvider,
	raw: Record<string, unknown>,
): Promise<Omit<CloudConnectionTestRecord, "at">> {
	const config = parse(provider, raw);
	const api = supabaseApi(provider, config.projectRef, config.accessToken);
	const steps: CloudConnectionTestRecord["steps"] = [];
	const info: Record<string, string> = {};
	const warnings: ErrorInfo[] = [];
	let project: Source["project"] | null = null;
	let canWrite: boolean | null = null;
	try {
		project = await api.project();
		info.project = project.name;
		info.region = project.region;
		info.status = project.status;
		if (project.database?.version) info.postgres = project.database.version;
		steps.push({ step: "api", ok: true });
	} catch (error) {
		steps.push({ step: "api", ok: false, error: errorInfoOf(error) });
	}
	try {
		if (!project) throw new AppError("CLOUD_API_UNREACHABLE", { detail: "" });
		const source = await resolveSource(provider, config, api, project);
		const version = await withCloudDb(source.db, async (query) => {
			const [row] = await query<{ version: string }>(
				"select current_setting('server_version') as version",
			);
			return row?.version ?? "";
		});
		info.pooler = `${source.db.host}:${source.db.port}`;
		info.server = version;
		canWrite = await cloudCanWrite(source);
		if (configuredTlsMode(source.db.ca) !== "verify-full") {
			warnings.push(coded("CLOUD_WARN_TLS_UNVERIFIED"));
		}
		steps.push({ step: "database", ok: true });
	} catch (error) {
		steps.push({ step: "database", ok: false, error: errorInfoOf(error) });
	}
	if (!hasKeys(config)) {
		steps.push({ step: "storage", ok: true, skipped: true });
	} else {
		try {
			const buckets = await listBuckets(
				provider,
				config,
				project?.region ?? "",
			);
			info.buckets = String(buckets.length);
			steps.push({ step: "storage", ok: true });
		} catch (error) {
			steps.push({ step: "storage", ok: false, error: errorInfoOf(error) });
		}
	}
	const ok = steps.every((step) => step.ok);
	const database = steps.find((step) => step.step === "database");
	return {
		ok,
		steps,
		info,
		warnings,
		directions: [
			{
				direction: "import",
				ok,
				reason: steps.find((step) => !step.ok)?.error ?? null,
			},
			{
				direction: "export",
				...exportCapability({
					databaseOk: database?.ok === true,
					databaseError: database?.error ?? null,
					canWrite,
				}),
			},
		],
	};
}

/** `^(anon|…)$` of the CLI's reserved roles. */
export const RESERVED_ROLE = new RegExp(`^(${RESERVED_ROLES.join("|")})$`);

/** Facts about the cloud database used by preflight and the job. */
async function databaseFacts(source: Source, ref: string) {
	return withCloudDb(source.db, async (query) => {
		const like = `%${ref}.supabase.co%`;
		const regclass = async (name: string) =>
			(
				await query<{ ok: boolean }>(
					"select to_regclass($1) is not null as ok",
					[name],
				)
			)[0]?.ok === true;
		const [version] = await query<{ version: string; size: string }>(
			"select current_setting('server_version') as version, pg_database_size(current_database())::text as size",
		);
		const tables = await query<{ schema: string; tables: string }>(
			"select n.nspname as schema, count(*)::text as tables from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') group by 1",
		);
		const storage = (await regclass("storage.objects"))
			? (
					await query<{ buckets: string; objects: string; size: string }>(
						"select (select count(*) from storage.buckets)::text as buckets, count(*)::text as objects, coalesce(sum((metadata->>'size')::bigint), 0)::text as size from storage.objects",
					)
				)[0]
			: undefined;
		const vault = (await regclass("vault.secrets"))
			? Number(
					(
						await query<{ n: string }>(
							"select count(*)::text as n from vault.secrets",
						)
					)[0]?.n ?? 0,
				)
			: 0;
		const extensions = (
			await query<{ name: string }>("select extname as name from pg_extension")
		).map((row) => row.name);
		const references: string[] = [];
		// Jobs are copied by their own step (paused by default); these
		// still call the cloud's domain wherever they end up.
		let cronJobs = 0;
		if (await regclass("cron.job")) {
			cronJobs = Number(
				(
					await query<{ n: string }>("select count(*)::text as n from cron.job")
				)[0]?.n ?? 0,
			);
			for (const row of await query<{ name: string }>(
				"select coalesce(jobname, jobid::text) as name from cron.job where command ilike $1",
				[like],
			)) {
				references.push(`cron: ${row.name}`);
			}
		}
		for (const row of await query<{ name: string }>(
			"select tgrelid::regclass::text || ' ' || tgname as name from pg_trigger where not tgisinternal and encode(tgargs, 'escape') ilike $1",
			[like],
		)) {
			references.push(`trigger: ${row.name}`);
		}
		for (const row of await query<{ schema: string; name: string }>(
			"select n.nspname as schema, p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.prosrc ilike $1",
			[like],
		)) {
			if (isUserSchema(row.schema)) {
				references.push(`function: ${row.schema}.${row.name}`);
			}
		}
		const roles = (
			await query<{ name: string }>(
				"select rolname as name from pg_roles where rolname !~ '^pg_' order by 1",
			)
		)
			.map((row) => row.name)
			.filter((name) => !RESERVED_ROLE.test(name));
		const userSchemas = tables.filter((row) => isUserSchema(row.schema));
		return {
			version: version?.version ?? "",
			sizeBytes: Number(version?.size ?? 0),
			tables: userSchemas.reduce((sum, row) => sum + Number(row.tables), 0),
			userSchemas: userSchemas.map((row) => row.schema),
			storage: storage
				? {
						buckets: Number(storage.buckets),
						objects: Number(storage.objects),
						sizeBytes: Number(storage.size),
					}
				: { buckets: 0, objects: 0, sizeBytes: 0 },
			vault,
			extensions,
			references,
			roles,
			cronJobs,
		};
	});
}

async function preflight(
	provider: CloudSyncProvider,
	raw: Record<string, unknown>,
	input: Parameters<CloudSyncDriver["preflight"]>[2],
): Promise<CloudPreflight> {
	if (input.direction === "export") {
		if (!input.source) throw internalError("Export preflight without its app");
		return exportPreflight(provider, raw, input, input.source);
	}
	const config = parse(provider, raw);
	const api = supabaseApi(provider, config.projectRef, config.accessToken);
	const source = await resolveSource(provider, config, api);
	const wants = (part: SyncPart) => input.parts.includes(part);
	const tls = configuredTlsMode(source.db.ca);
	if (tls === "missing") {
		// Nothing connects to the database until a CA is installed.
		const version = source.project.database?.version ?? "";
		return {
			project: {
				id: config.projectRef,
				name: source.project.name,
				region: source.project.region,
				status: source.project.status,
			},
			versions: { source: version, target: input.target.version },
			target: input.target,
			contents: [],
			requiredDiskBytes: 0,
			blockers: [errorInfoOf(caMissingError(source.db.caFile))],
			warnings: [],
		};
	}
	const facts = await databaseFacts(source, config.projectRef);
	const functions = wants("functions") ? await api.functions() : null;
	const rootKey =
		wants("database") && facts.vault > 0 ? await api.rootKey() : null;
	const versionText = source.project.database?.version || facts.version;
	const analysis = analyzePreflight({
		parts: input.parts,
		sourceMajor: postgresMajor(versionText),
		targetMajor: versionMajor(input.target.version),
		databaseBytes: facts.sizeBytes,
		storageBytes: facts.storage.sizeBytes,
		freeDiskBytes: input.target.freeDiskBytes,
		diskFactor: getConfig().CLOUD_SYNC_DISK_FACTOR,
		vaultSecrets: facts.vault,
		rootKeyAvailable: !!rootKey,
		extensions: facts.extensions,
		cloudReferences: facts.references,
		customRoles: facts.roles,
		functionsWithoutJwt: (functions ?? [])
			.filter((fn) => fn.verify_jwt === false)
			.map((fn) => fn.slug),
		functionCount: functions?.length ?? 0,
		tlsVerified: tls === "verify-full",
		hasStorageKeys: hasKeys(config),
		cronJobs: facts.cronJobs,
		cronMode: resolveCronMode(input.inputs?.cronJobs),
	});
	return {
		project: {
			id: config.projectRef,
			name: source.project.name,
			region: source.project.region,
			status: source.project.status,
		},
		versions: { source: versionText, target: input.target.version },
		target: input.target,
		contents: [
			...(wants("database")
				? [
						{
							part: "database",
							sizeBytes: facts.sizeBytes,
							counts: [{ unit: "tables" as const, count: facts.tables }],
						},
					]
				: []),
			...(wants("storage")
				? [
						{
							part: "storage",
							sizeBytes: facts.storage.sizeBytes,
							counts: [
								{ unit: "objects" as const, count: facts.storage.objects },
								{ unit: "buckets" as const, count: facts.storage.buckets },
							],
						},
					]
				: []),
			...(functions
				? [
						{
							part: "functions",
							sizeBytes: null,
							counts: [],
							names: functions.map((fn) => fn.slug),
						},
					]
				: []),
		],
		...analysis,
	};
}

// ---------------------------------------------------------------------------
// Import steps

export function pluginConfig(target: SyncTarget): SupabasePluginConfig {
	const parsed = SupabasePluginConfigSchema.safeParse(target.pluginConfig);
	if (!parsed.success) {
		throw new AppError("PLUGIN_CONFIG_INVALID", {
			detail: parsed.error.issues
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join("\n"),
		});
	}
	return parsed.data;
}

/** Endpoints of the dump (cloud) and the load (the app's db, localhost). */
export function endpoints(
	source: Source,
	target: SyncTarget,
	plugin: SupabasePluginConfig,
): { cloud: PgEndpoint; local: PgEndpoint } {
	const mode = configuredTlsMode(source.db.ca);
	if (mode === "missing") throw caMissingError(source.db.caFile);
	const port = Number(
		plugin.db_port_variable ? target.values[plugin.db_port_variable] : "",
	);
	return {
		cloud: {
			host: source.db.host,
			hostaddr: source.db.address,
			port: source.db.port,
			user: source.db.user,
			dbname: source.db.database,
			sslmode: mode,
			sslrootcert: mode === "verify-full" ? "/secrets/root.crt" : undefined,
			password: source.db.password,
		},
		local: {
			host: "127.0.0.1",
			port: Number.isInteger(port) && port > 0 ? port : 5432,
			user: plugin.db_user,
			dbname: plugin.db_name,
			sslmode: "disable",
			password: target.values[plugin.db_password] ?? "",
		},
	};
}

/** SQL in the app's database container (tuples output). */
export function appSql(
	target: SyncTarget,
	sql: string,
	failure: StepFailure,
): Promise<string> {
	const plugin = pluginConfig(target);
	return target.run(
		psqlCommand(
			{
				container: target.container(plugin.db_service),
				user: plugin.db_user,
				database: plugin.db_name,
				timeoutMs: getConfig().CLOUD_SYNC_JOB_TIMEOUT_MS,
			},
			true,
		),
		failure,
		{ input: sql, quiet: true },
	);
}

/** The app's database as a side of the cron step. */
export const appCronSide = (target: SyncTarget): CronSide => ({
	value: async (sql) =>
		(
			await appSql(
				target,
				sql,
				(detail) => new AppError("CLOUD_SYNC_CRON_FAILED", { detail }),
			)
		).trim(),
});

/** Write a function (or a shared `_name` folder) like the Edge Functions tab. */
async function writeFunction(
	target: SyncTarget,
	name: string,
	files: FunctionFile[],
	options: { shared?: boolean } = {},
): Promise<void> {
	const plugin = pluginConfig(target);
	const container = target.container(plugin.functions_service);
	const staging = `${STAGING_PREFIX}${name}-${randomBytes(4).toString("hex")}`;
	try {
		await target.run(
			deployFunctionScript(
				container,
				plugin.functions_dir,
				name,
				staging,
				options,
			),
			(detail) => new AppError("CLOUD_SYNC_FUNCTION_FAILED", { name, detail }),
			{ input: buildTar(staging, files), quiet: true },
		);
	} catch (error) {
		await target
			.run(
				cleanupStagingCommand(container, plugin.functions_dir),
				(detail) =>
					new AppError("CLOUD_SYNC_FUNCTION_FAILED", { name, detail }),
				{ quiet: true },
			)
			.catch(() => undefined);
		throw error;
	}
}

export async function listAppFunctions(target: SyncTarget): Promise<string[]> {
	const plugin = pluginConfig(target);
	const output = await target.run(
		listFunctionsCommand(
			target.container(plugin.functions_service),
			plugin.functions_dir,
		),
		(detail) =>
			new AppError("CLOUD_SYNC_FUNCTIONS_LIST_FAILED", {
				service: plugin.functions_service,
				detail,
			}),
		{ quiet: true },
	);
	return parseFunctionList(output, plugin.functions_reserved).map(
		(entry) => entry.name,
	);
}

export async function localMajor(target: SyncTarget): Promise<number> {
	const output = await appSql(
		target,
		"show server_version_num",
		"CLOUD_SYNC_LOCAL_VERSION_FAILED",
	);
	const number = Number(output.trim());
	if (!Number.isFinite(number) || number <= 0) {
		throw new AppError("CLOUD_SYNC_LOCAL_VERSION_FAILED", { detail: output });
	}
	return Math.floor(number / 10_000);
}

/** What the steps of one sync share. */
interface SyncState {
	rootKey: string | null;
	/** User schemas of the cloud database (row count comparison). */
	userSchemas: string[] | null;
	functions: SupabaseFunction[] | null;
	/** Cron jobs re-created in the app (null: none to compare). */
	cron: string[] | null;
	/** Tokens in the copied cron commands (redacted from the log). */
	cronSecrets: string[];
}

/** pg_cron jobs, through pg_cron's API (the data dump cannot carry them). */
function cronStep(
	source: Source,
	state: SyncState,
	mode: CronJobMode,
): SyncStep {
	return {
		id: "cron",
		part: "database",
		run: async (run) => {
			state.cron = await withCloudDb(source.db, (query) =>
				copyCronJobs({
					run,
					source: cloudCronSide(query),
					target: appCronSide(run.target),
					mode,
					unnamedPrefix: getConfig().CLOUD_SYNC_CRON_UNNAMED_PREFIX,
					// Kept for the rest of the job: later lines may echo them too.
					onSecrets: (values) => state.cronSecrets.push(...values),
				}),
			).catch(async (error) => {
				// Opening the connection failed: a warning, like any cron problem.
				await run.warn(errorInfoOf(error));
				return null;
			});
		},
	};
}

function databaseStep(source: Source, opened: SyncState): SyncStep {
	return {
		id: "database",
		part: "database",
		run: async (run) => {
			const { target, job } = run;
			const config = getConfig();
			const plugin = pluginConfig(target);
			const sourceMajor = postgresMajor(source.project.database?.version ?? "");
			if (sourceMajor === null)
				throw new AppError("CLOUD_SYNC_VERSION_UNKNOWN");
			const targetMajor = await localMajor(target);
			if (sourceMajor > targetMajor) {
				throw new AppError("CLOUD_SYNC_VERSION_DOWNGRADE", {
					source: sourceMajor,
					target: targetMajor,
				});
			}
			const clientMajor = Math.max(sourceMajor, targetMajor);
			const image = clientImage(
				config.CLOUD_SYNC_PG_CLIENT_IMAGES,
				clientMajor,
			);
			if (!image) {
				throw new AppError("CLOUD_SYNC_CLIENT_IMAGE_MISSING", {
					major: clientMajor,
				});
			}
			job.event("cloud_sync.local_version", {
				version: targetMajor,
				client: image,
			});
			const ends = endpoints(source, target, plugin);
			const secrets = `${target.workDir}/${SECRETS_DIR}`;
			const loadSecrets = `${target.workDir}/${LOAD_SECRETS_DIR}`;
			const dump = `${target.workDir}/${DUMP_DIR}`;
			// Each container sees only its own end's credentials.
			for (const [dir, service, end] of [
				[secrets, DUMP_SERVICE, ends.cloud],
				[loadSecrets, LOAD_SERVICE, ends.local],
			] as const) {
				await target.executor.upload(
					pgServiceFile({ [service]: end }),
					`${dir}/pg_service.conf`,
					"0600",
				);
				await target.executor.upload(
					pgpassFile([end]),
					`${dir}/pgpass`,
					"0600",
				);
			}
			if (source.db.ca) {
				await target.executor.upload(
					source.db.ca,
					`${secrets}/root.crt`,
					"0600",
				);
			}

			// Extensions the cloud uses that this image does not provide.
			const facts = await databaseFacts(source, source.project.ref);
			const available = new Set(
				(
					await appSql(
						target,
						"select name from pg_available_extensions",
						"CLOUD_SYNC_LOCAL_VERSION_FAILED",
					)
				)
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean),
			);
			const missing = facts.extensions.filter((name) => !available.has(name));
			if (missing.length) {
				await run.warn(
					coded("CLOUD_WARN_EXTENSIONS_MISSING", { names: asList(missing) }),
				);
			}

			// Vault secrets only decrypt with the project's key: copied with it.
			const kinds: DumpKind[] = [
				"roles",
				"schema",
				"data",
				...(opened.rootKey && facts.vault > 0 ? (["vault"] as const) : []),
			];
			if (!opened.rootKey && facts.vault > 0) {
				await run.warn(
					coded("CLOUD_WARN_VAULT_UNREADABLE", { count: facts.vault }),
				);
			}
			for (const kind of kinds) {
				job.event("cloud_sync.dumping", { kind });
				const file = `/${DUMP_DIR}/${kind}.sql`;
				const argv = dumpArgs(kind, file);
				await target.run(
					pgClientCommand({
						image,
						workDir: target.workDir,
						mode: "dump",
						network: config.CLOUD_SYNC_DUMP_NETWORK || undefined,
						argv,
					}),
					"CLOUD_SYNC_DUMP_FAILED",
					{ quiet: true },
				);
				const host = `${dump}/${kind}.sql`;
				if (kind === "roles" || kind === "schema") {
					// Small files: rewritten here like the CLI's sed pipeline,
					// then refused if a psql meta-command is left outside data.
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
					// Large: checked on the server, never pulled to the panel.
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

			const writers = plugin.sync_writer_services;
			const load = async () => {
				if (writers.length) {
					job.event("cloud_sync.writers_stopping", {
						services: asList(writers),
					});
					await target.compose(
						["stop", ...writers],
						"CLOUD_SYNC_WRITERS_STOP_FAILED",
					);
					await target.servicesStopped(writers);
				}
				if (opened.rootKey && plugin.db_root_key_file) {
					await target.run(
						writeKeyCommand(target, plugin),
						"CLOUD_SYNC_KEY_INSTALL_FAILED",
						{ input: `${opened.rootKey}\n`, quiet: true },
					);
					// The key is read when Postgres starts.
					await target.compose(
						["restart", plugin.db_service],
						"CLOUD_SYNC_KEY_INSTALL_FAILED",
					);
					await target.compose(
						["up", "-d", "--wait", "--no-build", plugin.db_service],
						"CLOUD_SYNC_KEY_INSTALL_FAILED",
					);
					job.event("cloud_sync.key_installed");
				}
				job.event("cloud_sync.loading");
				await loadDumps(target, job, {
					image,
					network: `container:${target.container(plugin.db_service)}`,
					files: kinds.map((kind) => `${kind}.sql`),
				});
				if (writers.length) {
					await target.compose(
						["up", "-d", "--no-build", ...writers],
						"CLOUD_SYNC_WRITERS_START_FAILED",
					);
					await target.servicesStarted(writers);
					job.event("cloud_sync.writers_started", {
						services: asList(writers),
					});
				}
			};
			await (job.critical ? job.critical("cloud_import_data", load) : load());
			opened.userSchemas = facts.userSchemas;
		},
	};
}

/**
 * Load the staged dumps with psql in a throwaway client container (the
 * load end's credentials only), then report the SQL errors: those the
 * destination's own objects cause are expected and not counted.
 */
export async function loadDumps(
	target: SyncTarget,
	job: SyncRun["job"],
	options: {
		image: string;
		network: string;
		files: string[];
		/** pg_service.conf section (default: the import's load end). */
		service?: string;
	},
): Promise<void> {
	const errFile = `${target.workDir}/${LOGS_DIR}/restore.err`;
	let loadError: unknown = null;
	try {
		await target.run(
			pgClientCommand({
				image: options.image,
				workDir: target.workDir,
				mode: "load",
				service: options.service,
				network: options.network,
				argv: restoreArgv(options.files),
				stderrFile: errFile,
			}),
			"CLOUD_SYNC_RESTORE_FAILED",
			{ quiet: true },
		);
	} catch (error) {
		loadError = error;
	}
	const errors = parseErrorLines(
		await target.run(
			errorLinesCommand(errFile, 200),
			"CLOUD_SYNC_RESTORE_FAILED",
			{ quiet: true },
		),
	);
	if (loadError && errors.count === 0) {
		const detail = await target
			.run(`head -c 4000 ${errFile}`, "CLOUD_SYNC_RESTORE_FAILED", {
				quiet: true,
			})
			.catch(() => "");
		throw commandError(
			"CLOUD_SYNC_RESTORE_FAILED",
			detail || errorDetail(loadError),
		);
	}
	const unexpected = errors.lines.filter(
		(line) => !EXPECTED_LOAD_ERRORS.test(line),
	);
	const counted = errors.count - (errors.lines.length - unexpected.length);
	job.event("cloud_sync.loaded", { errors: Math.max(0, counted) });
	for (const line of unexpected.slice(0, 20)) {
		job.event("cloud_sync.sql_warning", {
			line: clip(line, TEXT_LIMITS.errorDetail),
		});
	}
	if (counted > 0) await job.addWarnings?.(counted);
}

function writeKeyCommand(target: SyncTarget, plugin: SupabasePluginConfig) {
	return writeContainerFileCommand(
		target.container(plugin.db_service),
		plugin.db_root_key_file ?? "",
		plugin.db_root_key_owner ?? "postgres",
	);
}

function storageStep(
	provider: CloudSyncProvider,
	config: Config,
	source: Source,
): SyncStep {
	return {
		id: "storage",
		part: "storage",
		run: async (run) => {
			const { target, job } = run;
			if (!hasKeys(config)) {
				await run.warn(coded("CLOUD_WARN_STORAGE_NO_KEYS"));
				return;
			}
			const plugin = pluginConfig(target);
			const appConfig = getConfig();
			const counts = await withCloudDb(source.db, (query) =>
				query<{ bucket: string; objects: string }>(
					"select b.id as bucket, count(o.id)::text as objects from storage.buckets b left join storage.objects o on o.bucket_id = b.id group by b.id order by b.id",
				),
			);
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
			// The rclone container connects itself: allowlist + public check here.
			await pinnedHost(provider, new URL(s3Url(config.projectRef)).hostname);
			const confPath = `${target.workDir}/${RCLONE_SECRETS_DIR}/rclone.conf`;
			await target.executor.upload(
				renderRcloneSections({
					cloud: s3({
						endpoint: s3Url(config.projectRef),
						region: source.project.region,
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
			run.summary.buckets = [];
			for (const row of counts) {
				const objects = Number(row.objects);
				if (!BUCKET_PATTERN.test(row.bucket)) {
					await run.warn(
						coded("CLOUD_WARN_BUCKET_SKIPPED", { bucket: row.bucket }),
					);
					continue;
				}
				job.event("cloud_sync.bucket", { bucket: row.bucket, objects });
				const logName = `rclone-${row.bucket}.log`;
				let failed: unknown = null;
				try {
					await target.run(
						rcloneCommand({
							image: appConfig.RCLONE_IMAGE,
							confPath,
							remote: { section: {}, base: "" },
							// Only the logs folder: never the dumps or credentials.
							workDir: `${target.workDir}/${LOGS_DIR}`,
							network: appConfig.NITROBASE_NETWORK,
							args: bucketCopyArgs(
								row.bucket,
								appConfig.CLOUD_SYNC_RCLONE_TRANSFERS,
								`/work/${logName}`,
							),
						}),
						(detail) =>
							new AppError("CLOUD_SYNC_STORAGE_FAILED", {
								bucket: row.bucket,
								detail,
							}),
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
						(detail) =>
							new AppError("CLOUD_SYNC_STORAGE_FAILED", {
								bucket: row.bucket,
								detail,
							}),
						{ quiet: true },
					),
				);
				job.event("cloud_sync.bucket_done", {
					bucket: row.bucket,
					copied: copy.count,
				});
				run.summary.buckets.push({
					bucket: row.bucket,
					source: objects,
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
		},
	};
}

function functionsStep(source: Source, state: SyncState): SyncStep {
	return {
		id: "functions",
		part: "functions",
		run: async (run) => {
			const { target, job } = run;
			const appConfig = getConfig();
			const plugin = pluginConfig(target);
			const limits = {
				maxFiles: appConfig.SUPABASE_FUNCTION_MAX_FILES,
				maxBytes: appConfig.SUPABASE_FUNCTION_MAX_BYTES,
			};
			const functions = await source.api.functions();
			state.functions = functions;
			run.summary.functions = [];
			if (functions.length === 0) return;
			await run.warn(coded("CLOUD_WARN_FUNCTION_SECRETS"));
			const noJwt = functions
				.filter((fn) => fn.verify_jwt === false)
				.map((fn) => fn.slug);
			if (noJwt.length) {
				await run.warn(
					coded("CLOUD_WARN_FUNCTIONS_VERIFY_JWT", { names: asList(noJwt) }),
				);
			}
			const shared = new Map<string, Map<string, string | Buffer>>();
			const skip = async (name: string, error: unknown) => {
				job.event("cloud_sync.function_skipped", {
					name,
					reason: { $error: errorInfoOf(error) },
				});
				await job.addWarnings?.(1);
			};
			for (const fn of functions) {
				try {
					if (plugin.functions_reserved.includes(fn.slug)) {
						throw new AppError("FUNCTION_NAME_RESERVED", { name: fn.slug });
					}
					const body = await source.api.functionBody(fn);
					assertFunctionEntrypoint(fn.slug, body, plugin.functions_entrypoints);
					assertFunctionFiles(body.files, limits);
					await writeFunction(target, fn.slug, body.files);
					for (const [dir, files] of Object.entries(body.shared)) {
						const merged =
							shared.get(dir) ?? new Map<string, string | Buffer>();
						for (const file of files) merged.set(file.path, file.content);
						shared.set(dir, merged);
					}
					if (body.skipped.length) {
						await run.warn(
							coded("CLOUD_WARN_FUNCTION_FILES_SKIPPED", {
								name: fn.slug,
								paths: asList(body.skipped),
							}),
						);
					}
					job.event("cloud_sync.function", {
						name: fn.slug,
						files: body.files.length,
					});
					run.summary.functions.push({ slug: fn.slug, ok: true });
				} catch (error) {
					await skip(fn.slug, error);
					run.summary.functions.push({ slug: fn.slug, ok: false });
				}
			}
			for (const [dir, files] of shared) {
				const list = [...files].map(([path, content]) => ({ path, content }));
				try {
					assertFunctionFiles(list, limits);
					await writeFunction(target, dir, list, { shared: true });
				} catch (error) {
					await skip(dir, error);
				}
			}
			await target.compose(
				["restart", plugin.functions_service],
				(detail) =>
					new AppError("CLOUD_SYNC_FUNCTIONS_RESTART_FAILED", {
						service: plugin.functions_service,
						detail,
					}),
			);
		},
	};
}

function verifyStep(source: Source, state: SyncState): SyncStep {
	return {
		id: "verify",
		part: null,
		run: async (run) => {
			const { target, job } = run;
			const limit = getConfig().CLOUD_SYNC_VERIFY_MAX_TABLES;
			if (state.userSchemas) {
				const sql = rowCountsSql(state.userSchemas, PLATFORM_TABLES, limit);
				const cloud = await withCloudDb(source.db, (query) =>
					query<{ t: string; n: string }>(sql),
				);
				const local = parseRowCounts(
					await appSql(target, sql, "CLOUD_SYNC_VERIFY_FAILED"),
				);
				const tables = cloud.map((row) => ({
					table: row.t,
					source: Number(row.n),
					target: local.get(row.t) ?? 0,
				}));
				run.summary.tables = tables;
				const mismatches = tables.filter((row) => row.source !== row.target);
				for (const row of mismatches.slice(0, 50)) {
					job.event("cloud_sync.row_mismatch", row);
				}
				if (mismatches.length) await job.addWarnings?.(mismatches.length);
				job.event("cloud_sync.verified", {
					tables: tables.length,
					mismatches: mismatches.length,
				});
			}
			if (state.functions && run.summary.functions) {
				const present = new Set(await listAppFunctions(target));
				run.summary.functions = run.summary.functions.map((fn) => ({
					...fn,
					ok: fn.ok && present.has(fn.slug),
				}));
			}
			await verifyCronJobs(run, appCronSide(target), state.cron);
		},
	};
}

async function open(
	provider: CloudSyncProvider,
	raw: Record<string, unknown>,
	direction: SyncDirection,
	exportSource?: ExportSource,
	inputs: Record<string, unknown> = {},
): Promise<OpenedSync> {
	if (direction === "export") {
		if (!exportSource) throw internalError("Export without its app");
		return openExport(provider, raw, exportSource);
	}
	const cronMode = resolveCronMode(inputs.cronJobs);
	const config = parse(provider, raw);
	const api = supabaseApi(provider, config.projectRef, config.accessToken);
	const source = await resolveSource(provider, config, api);
	const status = source.project.status;
	if (!/^ACTIVE_/.test(status)) {
		throw new AppError("CLOUD_PROJECT_NOT_READY", { status });
	}
	const state: SyncState = {
		rootKey: null,
		userSchemas: null,
		functions: null,
		cron: null,
		cronSecrets: [],
	};
	return {
		project: config.projectRef,
		region: source.project.region,
		version: source.project.database?.version ?? "",
		secrets: () => [
			...(state.rootKey ? [state.rootKey] : []),
			...state.cronSecrets,
		],
		prepare: async (parts) => {
			if (parts.includes("database")) state.rootKey = await api.rootKey();
		},
		steps: (parts) => [
			...(parts.includes("database")
				? [databaseStep(source, state), cronStep(source, state, cronMode)]
				: []),
			...(parts.includes("storage")
				? [storageStep(provider, config, source)]
				: []),
			...(parts.includes("functions") ? [functionsStep(source, state)] : []),
			verifyStep(source, state),
		],
	};
}

/** The template's database major, from its rendered compose (null: unknown). */
async function targetVersion(probe: TemplateProbe): Promise<string | null> {
	const service = backupDatabaseService(probe.manifest.backup);
	if (!service) return null;
	try {
		const compose = parseYaml(await probe.compose()) as {
			services?: Record<string, { image?: string }>;
		};
		const major = imageMajor(compose.services?.[service]?.image);
		return major === null ? null : String(major);
	} catch {
		return null;
	}
}

/** The Postgres major of a target version (`targetVersion`). */
function versionMajor(version: string | null): number | null {
	const major = Number(version);
	return version && Number.isInteger(major) ? major : null;
}

export const supabaseDriver: CloudSyncDriver = {
	test,
	targetVersion,
	preflight,
	open,
	recover: recoverExport,
};
