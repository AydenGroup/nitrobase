import path from "node:path";
import { looksLikeFile } from "#/config/bind-files.ts";
import type { TemplateManifest } from "#/features/templates/schema.ts";
import { RESERVED_APP_ENTRIES } from "./compose-policy";
import { TemplateError } from "./naming";

/**
 * Bind mounts from inside the app folder, and which of them must be files.
 *
 * Docker creates a missing bind source as an empty directory, so a file a
 * service expects (a config, an init script) that the deploy did not write
 * silently becomes a directory and the service crash-loops (Appwrite 2.4.0:
 * `./clickhouse-init.sh` was bind-mounted but not fetched). A bind source
 * inside the app folder is:
 * - a rendered file (written by the deploy): must be a file, before and
 *   after `up` (hard check);
 * - a directory holding rendered files (config the deploy writes);
 * - declared runtime data (template `data_binds`, `[backup] paths`/`reset`;
 *   custom compose `dataBinds`): left to the app;
 * - anything else, unwritten: refused at render when upstream has a file
 *   at that path (`assertBindSourcesFetched`, the Appwrite bug). Otherwise,
 *   when its name says file (`#/config/bind-files.ts`): a warning before
 *   `up`, and a failure after `up` if it is still an empty directory (soft
 *   check: e.g. a file the owner put on the server keeps working). Any
 *   other name: a data directory, created empty before `up` as before.
 */

export interface AppBindSource {
	service: string;
	/** Path relative to the app folder (no `./`). */
	path: string;
}

/** Bind sources inside `appRoot` of a (transformed) compose model. */
export function appBindSources(
	composeModel: Record<string, unknown>,
	appRoot: string,
): AppBindSource[] {
	const out: AppBindSource[] = [];
	const seen = new Set<string>();
	const services = (composeModel.services ?? {}) as Record<
		string,
		{ volumes?: unknown[] } | null
	>;
	for (const [service, definition] of Object.entries(services)) {
		for (const volume of definition?.volumes ?? []) {
			let source: string | undefined;
			if (typeof volume === "string") {
				const parts = volume.split(":");
				if (parts.length > 1 && /^[./]/.test(parts[0])) source = parts[0];
			} else if (
				(volume as { type?: string })?.type === "bind" &&
				typeof (volume as { source?: unknown }).source === "string"
			) {
				source = (volume as { source: string }).source;
			}
			if (!source || source.includes("$")) continue;
			const absolute = path.posix.resolve(appRoot, source).replace(/\/+$/, "");
			if (!absolute.startsWith(`${appRoot}/`)) continue;
			const rel = absolute.slice(appRoot.length + 1);
			const key = `${service}\0${rel}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ service, path: rel });
		}
	}
	return out;
}

const within = (dir: string, file: string) =>
	file === dir || file.startsWith(`${dir}/`);

const normalized = (entry: string) =>
	path.posix.normalize(entry).replace(/\/+$/, "");

/**
 * App-relative paths the template declares as runtime data (created or
 * filled by the app): `data_binds` and the backed-up / reset folders.
 */
export function declaredDataPaths(
	manifest: Pick<TemplateManifest, "data_binds" | "backup">,
): string[] {
	return [
		...(manifest.data_binds ?? []),
		...manifest.backup.paths,
		...manifest.backup.reset,
	].map(normalized);
}

const isDeclared = (bind: AppBindSource, dataPaths: string[]) =>
	dataPaths.some((dir) => within(dir, bind.path));

/**
 * Bind sources the deploy writes nothing at: neither a rendered file nor a
 * directory holding rendered files (nor a reserved entry, refused by the
 * policy anyway), nor declared runtime data.
 */
export function unwrittenBindSources(input: {
	composeModel: Record<string, unknown>;
	appRoot: string;
	files: { path: string }[];
	dataPaths?: string[];
}): AppBindSource[] {
	const written = input.files.map((file) => file.path);
	const dataPaths = (input.dataPaths ?? []).map(normalized);
	return appBindSources(input.composeModel, input.appRoot).filter(
		(bind) =>
			!RESERVED_APP_ENTRIES.has(bind.path.split("/")[0]) &&
			!written.some((file) => within(bind.path, file)) &&
			!isDeclared(bind, dataPaths),
	);
}

/**
 * Whether the upstream listing is worth fetching for these unwritten bind
 * sources: only when one of them is named like a file (an extension-less
 * folder like `volumes/db/data` never needs it).
 */
export function needsUpstreamListing(candidates: AppBindSource[]): boolean {
	return candidates.some((bind) => looksLikeFile(bind.path));
}

/**
 * Refuse a bind source upstream has as a file that was not fetched (the
 * template's `source.include` misses it): Docker would mount an empty
 * directory in its place. `upstreamFiles`: file paths (relative to
 * `source.path`, i.e. to the app folder) that exist upstream, among (at
 * least) the `candidates`.
 */
export function assertBindSourcesFetched(
	candidates: AppBindSource[],
	upstreamFiles: ReadonlySet<string>,
): void {
	const missing = candidates.find((bind) => upstreamFiles.has(bind.path));
	if (missing) {
		throw new TemplateError("TEMPLATE_BIND_SOURCE_MISSING", {
			service: missing.service,
			path: missing.path,
		});
	}
}

export interface FileBinds {
	/** Rendered files that are bind sources: must be files (hard). */
	required: AppBindSource[];
	/**
	 * Unwritten, undeclared bind sources named like files: warned about
	 * before `up`, failed after `up` if still an empty directory (soft).
	 */
	named: AppBindSource[];
}

/** Bind sources that are expected to be files on the server. */
export function fileBindSources(input: {
	composeModel: Record<string, unknown>;
	appRoot: string;
	files: { path: string }[];
	/** App-relative runtime data the template declares (`declaredDataPaths`). */
	dataPaths: string[];
}): FileBinds {
	const written = new Set(input.files.map((file) => file.path));
	const dataPaths = input.dataPaths.map(normalized);
	const required: AppBindSource[] = [];
	const named: AppBindSource[] = [];
	for (const bind of appBindSources(input.composeModel, input.appRoot)) {
		if (RESERVED_APP_ENTRIES.has(bind.path.split("/")[0])) continue;
		if (written.has(bind.path)) {
			required.push(bind);
			continue;
		}
		if ([...written].some((file) => within(bind.path, file))) continue;
		if (isDeclared(bind, dataPaths)) continue;
		if (looksLikeFile(bind.path)) named.push(bind);
	}
	return { required, named };
}
