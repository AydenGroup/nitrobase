import path from "node:path";
import { z } from "zod";
import { getConfig } from "#/config/server.ts";
import { APP_ID } from "#/config/shared.ts";
import type { JobLogger } from "#/features/deployments/deployments.server.ts";
import {
	type StorageFilesConfig,
	type SupabasePluginConfig,
	SupabasePluginConfigSchema,
} from "#/features/supabase/schema.ts";
import { ENV_NAME_PATTERN } from "#/libs/naming-rules.ts";
import type { RestoreDataHookInput } from "#/plugins/server.ts";
import {
	type AppLocation,
	bindSourcesCheckScript,
} from "#/server/services/apps/commands.ts";
import { toolsCommand } from "#/server/services/backup/archive.ts";
import { errorInfoOf } from "#/server/services/error-info.ts";
import { type Executor, shellQuote as q } from "#/server/services/executor.ts";
import { AppError, commandError } from "#/utils/error.ts";
import { assertContainerName } from "./edge-functions";
import { formatPsqlError, type PsqlTarget, psqlCommand } from "./sql";

/**
 * Supabase Storage file backend metadata (BUG-007). The storage API keeps
 * an object's content type and cache control in `user.*` extended
 * attributes of its file and fails (500, ENODATA) when they are missing,
 * which is what archives made before backups kept extended attributes
 * restore. `storage.objects.metadata` has the same values (`mimetype`,
 * `cacheControl`), so the attributes can be rebuilt:
 *
 *  1. objects are read from the database in batches (keyset on `id`);
 *  2. each row is validated here (no `..`, empty or control-character
 *     segments) and turned into candidate file paths below the backend
 *     root (`<bucket>/<tenant>/<bucket_id>/<name><sep><version>`);
 *  3. a throwaway tools container (no network, the backend root mounted at
 *     /data) sets only the attributes a regular file lacks. Paths and
 *     values travel base64-encoded on stdin (never through a shell
 *     command line), symlinks are not followed and a file whose real path
 *     leaves /data is skipped.
 *
 * Its counts double as the post-restore check (files still missing their
 * attributes are reported as warnings).
 */

export interface StorageObjectRow {
	id: string;
	bucket_id: string;
	name: string | null;
	version: string | null;
	mimetype: string | null;
	cache_control: string | null;
}

const RowSchema = z.object({
	id: z.string(),
	bucket_id: z.string(),
	name: z.string().nullable(),
	version: z.string().nullable(),
	mimetype: z.string().nullable(),
	cache_control: z.string().nullable(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejects them
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Root bucket / tenant values from the app env (plain folder names). */
const ROOT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION = /^[A-Za-z0-9_-]{1,128}$/;
/** Linux NAME_MAX / PATH_MAX. */
const MAX_SEGMENT_BYTES = 255;
const MAX_PATH_BYTES = 4000;
const MAX_HEADER = 1024;

/** One batch of `storage.objects` after `afterId`, as a JSON array. */
export function storageObjectsQuery(
	afterId: string | null,
	limit: number,
): string {
	if (afterId !== null && !UUID.test(afterId)) {
		throw new AppError("STORAGE_METADATA_OUTPUT_UNEXPECTED");
	}
	const size = Math.min(10_000, Math.max(1, Math.floor(limit)));
	return [
		"SELECT coalesce(json_agg(row_to_json(o) ORDER BY o.id), '[]'::json) FROM (",
		"SELECT id, bucket_id, name, version,",
		"metadata->>'mimetype' AS mimetype, metadata->>'cacheControl' AS cache_control",
		"FROM storage.objects",
		// Validated UUID: safe as a literal.
		afterId ? `WHERE id > '${afterId}'::uuid` : "",
		`ORDER BY id LIMIT ${size}) o`,
	]
		.filter(Boolean)
		.join(" ");
}

export function parseStorageObjects(stdout: string): StorageObjectRow[] {
	let raw: unknown;
	try {
		raw = JSON.parse(stdout.trim() || "[]");
	} catch {
		throw new AppError("STORAGE_METADATA_OUTPUT_UNEXPECTED");
	}
	const parsed = z.array(RowSchema).safeParse(raw);
	if (!parsed.success) throw new AppError("STORAGE_METADATA_OUTPUT_UNEXPECTED");
	return parsed.data;
}

/** A path segment from the database: no `/`, `.`, `..` or control chars. */
export function isSafeSegment(segment: string): boolean {
	return (
		segment.length > 0 &&
		segment !== "." &&
		segment !== ".." &&
		!segment.includes("/") &&
		!CONTROL.test(segment) &&
		Buffer.byteLength(segment, "utf8") <= MAX_SEGMENT_BYTES
	);
}

/** `[root bucket, tenant]` from the app env (folder names under the root). */
export function storageRootSegments(
	config: Pick<StorageFilesConfig, "bucket_variable" | "tenant_variable">,
	values: Record<string, string>,
): [string, string] {
	const read = (variable: string) => {
		const value = values[variable] ?? "";
		if (!ROOT_SEGMENT.test(value) || value === "..") {
			throw new AppError("STORAGE_FILES_VARIABLE_INVALID", { variable });
		}
		return value;
	};
	return [read(config.bucket_variable), read(config.tenant_variable)];
}

/**
 * Candidate file paths of an object, relative to the backend root, in
 * the order the storage API may have written them. Null: unsafe row.
 */
export function objectCandidates(
	row: Pick<StorageObjectRow, "bucket_id" | "name" | "version">,
	root: [string, string],
	separators: readonly string[],
): string[] | null {
	if (!row.name || !isSafeSegment(row.bucket_id)) return null;
	const segments = row.name.split("/");
	if (!segments.every(isSafeSegment)) return null;
	const base = [...root, row.bucket_id, ...segments].join("/");
	let candidates: string[];
	if (row.version === null) {
		candidates = [base];
	} else {
		if (!VERSION.test(row.version)) return null;
		candidates = [...new Set(separators)].map(
			(separator) => `${base}${separator}${row.version}`,
		);
	}
	const safe = candidates.filter(
		(candidate) =>
			Buffer.byteLength(candidate, "utf8") <= MAX_PATH_BYTES &&
			path.posix.normalize(candidate) === candidate &&
			!candidate.split("/").includes(".."),
	);
	return safe.length ? safe : null;
}

/** A header value from the database, else the storage API's default. */
export function headerValue(value: string | null, fallback: string): string {
	return value && value.length <= MAX_HEADER && !CONTROL.test(value)
		? value
		: fallback;
}

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

/**
 * stdin of the repair script: one line per object,
 * `<content type> <cache control> <candidate>...`, each base64.
 */
export function repairInput(
	rows: StorageObjectRow[],
	config: Pick<
		StorageFilesConfig,
		"version_separators" | "default_content_type" | "default_cache_control"
	>,
	root: [string, string],
): { input: string; objects: number; unsafe: number } {
	const lines: string[] = [];
	let unsafe = 0;
	for (const row of rows) {
		const candidates = objectCandidates(row, root, config.version_separators);
		if (!candidates) {
			unsafe++;
			continue;
		}
		lines.push(
			[
				b64(headerValue(row.mimetype, config.default_content_type)),
				b64(headerValue(row.cache_control, config.default_cache_control)),
				...candidates.map(b64),
			].join(" "),
		);
	}
	return {
		input: lines.length ? `${lines.join("\n")}\n` : "",
		objects: lines.length,
		unsafe,
	};
}

/** Summary line marker printed by the script. */
const REPAIR_SUMMARY_MARKER = `${APP_ID}-storage-repair`;

/**
 * Runs in the tools container (`attr`: getfattr/setfattr; coreutils
 * realpath/base64). `$1`/`$2`: the content-type / cache-control attribute
 * names. Values are given to setfattr in its base64 form (`0s…`), so no
 * value is ever read as an option or a hex/quoted encoding.
 */
export const REPAIR_SCRIPT = [
	"set -u -f",
	"fixed=0 ok=0 missing=0 unsafe=0 failed=0",
	"dec() { printf '%s' \"$1\" | base64 -d; }",
	// 0: had it, 1: set, 2: failed.
	'fix() { if getfattr --absolute-names -n "$2" -- "$1" >/dev/null 2>&1; then return 0; fi; setfattr -n "$2" -v "0s$3" -- "$1" 2>/dev/null && return 1; return 2; }',
	"while read -r ct cc paths; do",
	'  [ -n "$paths" ] || continue',
	"  file=",
	"  for c in $paths; do",
	'    p="/data/$(dec "$c")" || continue',
	'    if [ -L "$p" ]; then file=-; break; fi',
	'    if [ -f "$p" ]; then file=$p; break; fi',
	"  done",
	'  if [ -z "$file" ]; then missing=$((missing+1)); continue; fi',
	'  if [ "$file" = - ]; then unsafe=$((unsafe+1)); continue; fi',
	'  real=$(realpath -e -- "$file" 2>/dev/null) || { missing=$((missing+1)); continue; }',
	'  case "$real" in /data/*) ;; *) unsafe=$((unsafe+1)); continue ;; esac',
	'  [ -f "$real" ] && [ ! -L "$real" ] || { unsafe=$((unsafe+1)); continue; }',
	'  fix "$real" "$1" "$ct"; a=$?',
	'  fix "$real" "$2" "$cc"; b=$?',
	"  if [ $a -eq 2 ] || [ $b -eq 2 ]; then failed=$((failed+1))",
	"  elif [ $a -eq 1 ] || [ $b -eq 1 ]; then fixed=$((fixed+1))",
	"  else ok=$((ok+1)); fi",
	"done",
	`printf '${REPAIR_SUMMARY_MARKER} fixed=%d ok=%d missing=%d unsafe=%d failed=%d\\n' "$fixed" "$ok" "$missing" "$unsafe" "$failed"`,
].join("\n");

/** The repair container: backend root at /data, rows on stdin. */
export function repairCommand(
	image: string,
	hostRoot: string,
	config: Pick<
		StorageFilesConfig,
		"content_type_xattr" | "cache_control_xattr"
	>,
): string {
	return toolsCommand(
		image,
		[{ source: hostRoot, target: "/data" }],
		REPAIR_SCRIPT,
		[config.content_type_xattr, config.cache_control_xattr],
	);
}

interface RepairCounts {
	fixed: number;
	ok: number;
	missing: number;
	unsafe: number;
	failed: number;
}

export function parseRepairSummary(stdout: string): RepairCounts {
	const line = stdout
		.split("\n")
		.reverse()
		.find((item) => item.startsWith(`${REPAIR_SUMMARY_MARKER} `));
	const match = line
		? /fixed=(\d+) ok=(\d+) missing=(\d+) unsafe=(\d+) failed=(\d+)$/.exec(
				line.trim(),
			)
		: null;
	if (!match) throw new AppError("STORAGE_METADATA_OUTPUT_UNEXPECTED");
	const [fixed, ok, missing, unsafe, failed] = match.slice(1).map(Number);
	return { fixed, ok, missing, unsafe, failed };
}

export interface RepairTotals extends RepairCounts {
	/** Rows read from `storage.objects`. */
	objects: number;
}

/** Host folder of the backend root (validated relative app path). */
export function storageHostRoot(
	location: AppLocation,
	config: Pick<StorageFilesConfig, "path">,
): string {
	const root = path.posix.normalize(`${location.appRoot}/${config.path}`);
	if (!root.startsWith(`${location.appRoot}/`)) {
		throw new AppError("STORAGE_FILES_UNSUPPORTED");
	}
	return root;
}

/**
 * The storage container's backend variable, filtered on the server (the
 * container env holds secrets: only `NAME=value` of that one variable is
 * printed). Exit 3: no such container.
 */
export function storageBackendCommand(
	container: string,
	variable: string,
): string {
	assertContainerName(container);
	if (!ENV_NAME_PATTERN.test(variable)) {
		throw new AppError("STORAGE_FILES_UNSUPPORTED");
	}
	const script = [
		`env=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' -- "$1" 2>/dev/null) || exit 3`,
		`printf '%s\\n' "$env" | grep -m1 -- "^$2=" || true`,
	].join("\n");
	return `sh -c ${q(script)} sh ${q(container)} ${q(variable)}`;
}

/** The variable's value from `storageBackendCommand` output; null: unset. */
export function parseStorageBackend(
	stdout: string,
	variable: string,
): string | null {
	const line = stdout
		.split("\n")
		.find((item) => item.startsWith(`${variable}=`));
	return line === undefined ? null : line.slice(variable.length + 1).trim();
}

/** The storage container's backend (null: the variable is not set). */
export async function readStorageBackend(
	executor: Executor,
	container: string,
	config: Pick<StorageFilesConfig, "backend_variable">,
	options: { timeoutMs: number; signal?: AbortSignal },
): Promise<string | null> {
	const result = await executor.exec(
		storageBackendCommand(container, config.backend_variable),
		options,
	);
	if (result.exitCode !== 0) {
		throw commandError(
			"STORAGE_BACKEND_CHECK_FAILED",
			result.stderr || result.stdout || `exit ${result.exitCode}`,
		);
	}
	return parseStorageBackend(result.stdout, config.backend_variable);
}

/** getfattr/setfattr in the tools image (images built before `attr`). */
export function attrProbeCommand(image: string): string {
	return toolsCommand(
		image,
		[],
		"command -v setfattr >/dev/null && command -v getfattr >/dev/null",
	);
}

/**
 * Rebuild missing storage attributes from `storage.objects` (database
 * service running). Never removes or overwrites an attribute a file has.
 */
export async function repairStorageMetadata(input: {
	executor: Executor;
	toolsImage: string;
	config: StorageFilesConfig;
	values: Record<string, string>;
	location: AppLocation;
	database: PsqlTarget;
	batchSize: number;
	timeoutMs: number;
	signal?: AbortSignal;
	/** After each batch (running totals). */
	onBatch?: (totals: RepairTotals) => void;
}): Promise<RepairTotals> {
	const { executor, config } = input;
	const root = storageRootSegments(config, input.values);
	const hostRoot = storageHostRoot(input.location, config);
	// Never mount a folder an app container swapped for a symlink.
	const check = await executor.exec(
		bindSourcesCheckScript(input.location, [hostRoot]),
		{ timeoutMs: input.timeoutMs, signal: input.signal },
	);
	if (check.exitCode !== 0) {
		throw commandError(
			"COMPOSE_UNSAFE_BIND",
			check.stderr || check.stdout || `exit ${check.exitCode}`,
		);
	}
	const probe = await executor.exec(attrProbeCommand(input.toolsImage), {
		timeoutMs: input.timeoutMs,
		signal: input.signal,
	});
	if (probe.exitCode !== 0) {
		throw new AppError("BACKUP_TOOLS_NO_ATTR", { image: input.toolsImage });
	}
	const totals: RepairTotals = {
		objects: 0,
		fixed: 0,
		ok: 0,
		missing: 0,
		unsafe: 0,
		failed: 0,
	};
	let afterId: string | null = null;
	for (;;) {
		const query = await executor.exec(psqlCommand(input.database, true), {
			input: storageObjectsQuery(afterId, input.batchSize),
			timeoutMs: input.timeoutMs,
			signal: input.signal,
		});
		if (query.exitCode !== 0) {
			throw commandError(
				"STORAGE_METADATA_QUERY_FAILED",
				formatPsqlError(query.stderr || query.stdout),
			);
		}
		const rows = parseStorageObjects(query.stdout);
		if (!rows.length) break;
		totals.objects += rows.length;
		const batch = repairInput(rows, config, root);
		totals.unsafe += batch.unsafe;
		if (batch.objects) {
			const result = await executor.exec(
				repairCommand(input.toolsImage, hostRoot, config),
				{
					input: batch.input,
					timeoutMs: input.timeoutMs,
					signal: input.signal,
				},
			);
			if (result.exitCode !== 0) {
				throw commandError(
					"STORAGE_METADATA_REPAIR_FAILED",
					result.stderr || result.stdout || `exit ${result.exitCode}`,
				);
			}
			const counts = parseRepairSummary(result.stdout);
			for (const key of Object.keys(counts) as (keyof RepairCounts)[]) {
				totals[key] += counts[key];
			}
		}
		input.onBatch?.({ ...totals });
		const last = rows[rows.length - 1].id;
		if (rows.length < input.batchSize || !UUID.test(last)) break;
		afterId = last;
	}
	return totals;
}

/** What a check reports to its job (a restore's or the on-demand one's). */
export interface StorageCheckJob {
	event: JobLogger["event"];
	addWarnings?: (count: number) => Promise<void>;
	signal?: AbortSignal;
}

/**
 * Repair + check with job events: problems left (objects without a file,
 * skipped, failed) are job warnings. Skipped (null, with a log note) when
 * storage does not use the file backend.
 */
export async function checkStorageFiles(
	input: Omit<Parameters<typeof repairStorageMetadata>[0], "onBatch"> & {
		/** Container of the storage service (its env says the backend). */
		storageContainer: string;
	},
	job: StorageCheckJob,
): Promise<RepairTotals | null> {
	const backend = await readStorageBackend(
		input.executor,
		input.storageContainer,
		input.config,
		{ timeoutMs: input.timeoutMs, signal: input.signal ?? job.signal },
	);
	if (backend === null) {
		job.event("supabase.storage_backend_unset", {
			variable: input.config.backend_variable,
		});
		return null;
	}
	if (backend !== input.config.backend_value) {
		job.event("supabase.storage_not_file_backend", { backend });
		return null;
	}
	job.event("supabase.storage_checking");
	const totals = await repairStorageMetadata({
		...input,
		signal: input.signal ?? job.signal,
		onBatch: (running) => {
			if (running.objects >= input.batchSize) {
				job.event("supabase.storage_progress", {
					objects: running.objects,
					fixed: running.fixed,
				});
			}
		},
	});
	job.event("supabase.storage_checked", {
		objects: totals.objects,
		fixed: totals.fixed,
		ok: totals.ok,
	});
	if (totals.fixed) {
		job.event("supabase.storage_repaired", { fixed: totals.fixed });
	}
	if (totals.missing) {
		job.event("supabase.storage_missing", { count: totals.missing });
	}
	if (totals.unsafe) {
		job.event("supabase.storage_unsafe", { count: totals.unsafe });
	}
	if (totals.failed) {
		job.event("supabase.storage_failed", { count: totals.failed });
	}
	const warnings = totals.missing + totals.unsafe + totals.failed;
	if (warnings) await job.addWarnings?.(warnings);
	return totals;
}

/** Where the check reads `storage.objects` (the plugin's db settings). */
export function storageDatabaseTarget(
	config: Pick<SupabasePluginConfig, "db_service" | "db_user" | "db_name">,
	container: (service: string) => string,
	timeoutMs: number,
): PsqlTarget {
	return {
		container: container(config.db_service),
		user: config.db_user,
		database: config.db_name,
		timeoutMs,
	};
}

/**
 * Supabase `afterRestoreData`: rebuild missing storage attributes (old
 * archives) and report files still lacking them. Never fails the restore.
 */
export async function supabaseRestoreCheck(
	input: RestoreDataHookInput,
): Promise<void> {
	const parsed = SupabasePluginConfigSchema.safeParse(input.pluginConfig);
	const storage = parsed.success ? parsed.data.storage_files : undefined;
	if (!parsed.success || !storage) return;
	const settings = getConfig();
	try {
		await checkStorageFiles(
			{
				executor: input.executor,
				toolsImage: input.toolsImage,
				config: storage,
				values: input.values,
				location: input.location,
				storageContainer: input.container(storage.service),
				database: storageDatabaseTarget(
					parsed.data,
					input.container,
					settings.SUPABASE_SQL_TIMEOUT_MS,
				),
				batchSize: settings.SUPABASE_STORAGE_REPAIR_BATCH,
				timeoutMs: settings.SUPABASE_STORAGE_REPAIR_TIMEOUT_MS,
			},
			input.job,
		);
	} catch (error) {
		if (input.job.signal?.aborted) throw error;
		input.job.event("supabase.storage_check_failed", {
			error: { $error: errorInfoOf(error) },
		});
		await input.job.addWarnings?.(1);
	}
}
