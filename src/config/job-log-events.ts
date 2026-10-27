import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { cloudVersionLabels, syncPartLabels } from "#/config/cloud-sync.ts";
import { lookup } from "#/config/labels.ts";
import {
	type CodedParams,
	type CodedValue,
	formatCodedParams,
} from "#/libs/coded.ts";
import type { LogLevel } from "#/libs/job-log.ts";

/**
 * Job log events: lines the panel itself writes to a job log, as a code and
 * params (`ctx.event(code, params)`), rendered in the reader's language by
 * the log viewer. Raw command output stays plain text (`ctx.log`). The
 * level colors the line.
 */
export interface LogEventDef<P> {
	message: MessageDescriptor;
	level: LogLevel;
	/** Type-only marker of the params (never set). */
	readonly params?: P;
}

type Params = CodedParams;
type None = Record<never, never>;

const info = <P extends Params = None>(
	message: MessageDescriptor,
): LogEventDef<NoInfer<P>> => ({ message, level: "info" });
const success = <P extends Params = None>(
	message: MessageDescriptor,
): LogEventDef<NoInfer<P>> => ({ message, level: "success" });
const warning = <P extends Params = None>(
	message: MessageDescriptor,
): LogEventDef<NoInfer<P>> => ({ message, level: "warning" });
const failure = <P extends Params = None>(
	message: MessageDescriptor,
): LogEventDef<NoInfer<P>> => ({ message, level: "error" });

type Err = { error: CodedValue };

/**
 * Steps a cancel waits for (`ctx.critical(step, ...)`): the `step` param of
 * log events holds one of these keys.
 */
export const jobSteps = {
	restore_data: msg({ id: "restoring the data" }),
	managed_key_install: msg({ id: "installing the managed SSH key" }),
	traefik_swap: msg({ id: "replacing the Traefik container" }),
	cloud_import_data: msg({ id: "loading the imported database" }),
	cloud_export_data: msg({ id: "loading the database into the cloud project" }),
} satisfies Record<string, MessageDescriptor>;
export type JobStep = keyof typeof jobSteps;

/**
 * What a cancel leaves behind (`ctx.setCancelState(state)`): the `state`
 * param of log events holds one of these keys.
 */
export const cancelStates = {
	app_partly_updated: msg({
		id: "the app may be partly updated or stopped: redeploy it to converge.",
	}),
	move_not_started: msg({
		id: "nothing was moved: the app runs on the source.",
	}),
	move_rolled_back: msg({
		id: "the move is rolled back: the copy on the target is removed and the app is started on the source again.",
	}),
	move_on_target: msg({
		id: "the app runs on the target; the source copy may still need removing.",
	}),
	backup_not_stored: msg({
		id: "no archive was stored; services the backup stopped are started again.",
	}),
	restore_data_done: msg({
		id: "the data was restored but the app may be stopped: redeploy it, or run the restore again.",
	}),
	restore_nothing_changed: msg({
		id: "nothing was changed: the app runs as before.",
	}),
	cloud_import_partial: msg({
		id: "the new app exists but may be partly imported: delete it, then import again.",
	}),
	cloud_export_partial: msg({
		id: "the cloud project may hold part of the export: empty it (or create a new project), then export again.",
	}),
	bootstrap_partial: msg({
		id: "the server may be partly set up; run Bootstrap again (it is safe to re-run).",
	}),
} satisfies Record<string, MessageDescriptor>;
export type CancelState = keyof typeof cancelStates;

/** Stages of an Appwrite migration (`GET /v1/migrations/{id}` → `stage`). */
const appwriteMigrationStages = {
	init: msg({ id: "starting" }),
	processing: msg({ id: "processing" }),
	"source-check": msg({ id: "checking the source" }),
	"destination-check": msg({ id: "checking the destination" }),
	migrating: msg({ id: "copying" }),
	finished: msg({ id: "finished" }),
} satisfies Record<string, MessageDescriptor>;

/** Params holding registry keys, rendered as their translated text. */
const keyParams: Record<string, Record<string, MessageDescriptor>> = {
	step: jobSteps,
	state: cancelStates,
	part: syncPartLabels,
	product: cloudVersionLabels,
	migration_stage: appwriteMigrationStages,
};

export const jobLogEvents = {
	// Job runner
	"job.error": failure<Err>(msg({ id: "ERROR: {error}" })),
	"job.cancel_requested_wait": info<{ step: JobStep }>(
		msg({
			id: "Cancel requested: waiting for “{step}” to finish so nothing is left half-done...",
		}),
	),
	"job.cancel_requested": info(
		msg({ id: "Cancel requested: stopping the running command..." }),
	),
	"job.cancelling": info(msg({ id: "Cancelling now." })),
	"job.cancelled": warning(msg({ id: "Job cancelled." })),
	"job.cancelled_state": warning<{ state: CancelState }>(
		msg({ id: "Job cancelled. State: {state}" }),
	),
	"job.waiting_server": info(
		msg({ id: "Waiting for the server's current job to finish..." }),
	),
	"job.restart_failed": failure<{ services: CodedValue } & Err>(
		msg({ id: "ERROR: could not start {services} again: {error}" }),
	),
	"job.warning": warning<{ warning: CodedValue }>(
		msg({ id: "Warning: {warning}" }),
	),
	"recover.restarting": info<{ job: string; services: CodedValue }>(
		msg({
			id: "A job ({job}) was interrupted with {services} stopped; starting them again...",
		}),
	),
	"recover.done": success(msg({ id: "SUCCESS: services started" })),
	"deploy.rendering": info<{ template: string; version: string }>(
		msg({ id: "Rendering {template} {version}..." }),
	),
	"deploy.pinned": info<{ version: string; commit: string }>(
		msg({ id: "Pinned {version} at commit {commit}" }),
	),
	"deploy.writing_files": info<{ count: number; path: string }>(
		msg({ id: "Writing {count} files to {path}..." }),
	),
	"deploy.bind_file_warning": warning<{ service: string; path: string }>(
		msg({
			id: "{service} mounts {path} from the app folder, which is named like a file but nothing writes it and it is not on the server yet: Docker will create an empty folder there, and the deploy then fails. Create the file in the app folder, or declare the path as runtime data if the app creates it itself.",
		}),
	),
	"deploy.empty_dir_replaced": warning<{ path: string }>(
		msg({
			id: "Replaced the empty folder {path} (left by Docker for a file that was missing) with the file",
		}),
	),
	"deploy.validating": info(
		msg({ id: "Validating the resolved compose file..." }),
	),
	"deploy.pulling": info(msg({ id: "Pulling images and building..." })),
	"deploy.pull_progress": info<{ elapsed: CodedValue }>(
		msg({ id: "Still pulling images and building... ({elapsed})" }),
	),
	"deploy.starting": info(msg({ id: "Starting containers..." })),
	"deploy.waiting_ready": info(
		msg({ id: "Waiting for containers to become ready..." }),
	),
	"deploy.status": info<{ status: string }>(
		msg({ id: "Containers: {status}" }),
	),
	"deploy.no_containers": info(msg({ id: "No containers yet" })),
	"deploy.probing": info<{ url: string }>(msg({ id: "Probing {url}..." })),
	"deploy.health_ok": success<{ code: number }>(
		msg({ id: "Health check passed (HTTP {code})" }),
	),
	"deploy.health_ok_expected": success<{ code: number; expected: string }>(
		msg({ id: "Health check passed (HTTP {code}, expected {expected})" }),
	),
	"deploy.restarting_dependents": info<{
		changed: CodedValue;
		services: CodedValue;
	}>(
		msg({
			id: "Restarting {services}: they depend on {changed}, which this deploy recreated or restarted...",
		}),
	),
	"deploy.routes_updated": info<{ hosts: CodedValue }>(
		msg({ id: "Routes updated: {hosts}" }),
	),
	"deploy.running": success<{ app: string }>(
		msg({ id: "SUCCESS: {app} is running" }),
	),
	"deploy.failure_hint": warning<{ hint: CodedValue }>(
		msg({ id: "Hint: {hint}" }),
	),
	"deploy.env_recovered": info<{ count: number }>(
		msg({
			id: "An earlier deploy of this app did not finish: reusing {count, plural, one {# generated value} other {# generated values}} from the app's .env on the server.",
		}),
	),
	"deploy.secrets_new_with_data": warning(
		msg({
			id: "This app already has data on the server, but no generated values were stored or found in its .env: new secrets were generated. Services that keep a secret in their data (e.g. a database password) may refuse the new one; restore a backup or remove the app's data if this happens.",
		}),
	),
	"deploy.files_refreshed": info<{ app: string; count: number }>(
		msg({
			id: "{app}: files updated ({count, plural, one {# link network} other {# link networks}})",
		}),
	),
	"app.starting_service": info<{ service: string }>(
		msg({ id: "Starting {service}..." }),
	),
	"app.stopping_service": info<{ service: string }>(
		msg({ id: "Stopping {service}..." }),
	),
	"app.restarting_service": info<{ service: string }>(
		msg({ id: "Restarting {service}..." }),
	),
	"app.starting_all": info(msg({ id: "Starting all services..." })),
	"app.stopping_all": info(msg({ id: "Stopping all services..." })),
	"app.restarting_all": info(msg({ id: "Restarting all services..." })),
	"app.started": success(msg({ id: "SUCCESS: started" })),
	"app.stopped": success(msg({ id: "SUCCESS: stopped" })),
	"app.restarted": success(msg({ id: "SUCCESS: restarted" })),
	"routes.not_deployed": info(
		msg({ id: "App is not deployed yet; routes will be written on deploy." }),
	),
	"teardown.routes": info(msg({ id: "Removing routes..." })),
	"teardown.down": info(msg({ id: "Stopping containers..." })),
	"teardown.down_wipe": info(
		msg({ id: "Stopping containers and removing volumes..." }),
	),
	"teardown.images": info(
		msg({ id: "Removing images not used by other containers..." }),
	),
	"teardown.folder": info<{ path: string }>(msg({ id: "Removing {path}..." })),
	"teardown.kept": info<{ path: string }>(
		msg({ id: "Data kept in {path} and the app's named volumes." }),
	),
	"app.deleted": success<{ app: string }>(
		msg({ id: "SUCCESS: {app} deleted" }),
	),
	"app.rotating": info<{ name: string }>(
		msg({ id: "Generating a new {name}..." }),
	),
	"app.rotate_hook_running": info<{ name: string; service: string }>(
		msg({
			id: "Running the follow-up step of the {name} rotation in {service}...",
		}),
	),
	"app.rotate_hook_done": success<{ name: string }>(
		msg({ id: "SUCCESS: follow-up step of the {name} rotation done" }),
	),
	"app.rotate_hook_skipped": info<{ name: string }>(
		msg({
			id: "Follow-up step of the {name} rotation skipped (not selected).",
		}),
	),
	"app.writing_env": info<{ file: string }>(msg({ id: "Writing {file}..." })),
	"app.recreating": info<{ service: string }>(
		msg({ id: "Recreating {service} with the new environment..." }),
	),
	"app.env_updated": success<{ service: string }>(
		msg({ id: "SUCCESS: {service} environment updated" }),
	),
	"backup.rclone_details": info(msg({ id: "Details:" })),
	"restore.downloading": info<{ path: string }>(
		msg({ id: "Downloading {path}..." }),
	),
	"restore.checksum_ok": info(msg({ id: "Checksum verified" })),
	"restore.members_ok": info(
		msg({ id: "Members verified against manifest.json" }),
	),
	"restore.stopping": info(
		msg({ id: "Stopping the app and creating its containers..." }),
	),
	"restore.path_skipped": warning<{ path: string }>(
		msg({
			id: "Warning: {path} is not a backup path of this template, skipped",
		}),
	),
	"restore.volume_skipped": warning<{ volume: string }>(
		msg({
			id: "Warning: volume {volume} is not a backup volume of this template, skipped",
		}),
	),
	"restore.restoring_path": info<{ path: string }>(
		msg({ id: "Restoring {path}..." }),
	),
	"restore.restoring_volume": info<{ volume: string }>(
		msg({ id: "Restoring volume {volume}..." }),
	),
	"restore.reset_path": info<{ path: string }>(
		msg({ id: "Emptying {path} for a fresh database..." }),
	),
	"restore.reset_volume": info<{ volume: string }>(
		msg({ id: "Emptying volume {volume} for a fresh database..." }),
	),
	"restore.db_starting": info<{ service: string }>(
		msg({ id: "Starting {service} and loading the dump..." }),
	),
	"restore.db_loaded": info<{ conflicts: number; errors: number }>(
		msg({
			id: "Database loaded ({conflicts} expected conflicts with objects created by the image, {errors} other errors)",
		}),
	),
	"restore.sql_warning": warning<{ line: string }>(
		msg({ id: "Warning: {line}" }),
	),
	"restore.db_errors": warning<{ count: number }>(
		msg({
			id: "Warning: the database was restored with {count, plural, one {# SQL error} other {# SQL errors}} (set [backup.database].strict = true to fail instead)",
		}),
	),
	"restore.done": success<{ app: string; date: CodedValue }>(
		msg({ id: "SUCCESS: restored {app} from {date}" }),
	),
	"restore.verified": success(msg({ id: "SUCCESS: the archive is intact" })),

	// Supabase Storage file metadata (restore check, on-demand repair)
	"supabase.storage_not_file_backend": info<{ backend: string }>(
		msg({
			id: "Storage uses the {backend} backend, not files: no file metadata to check",
		}),
	),
	"supabase.storage_backend_unset": info<{ variable: string }>(
		msg({
			id: "The storage service has no {variable} setting: storage file metadata not checked",
		}),
	),
	"supabase.storage_checking": info(
		msg({ id: "Checking the extended attributes of the storage files..." }),
	),
	"supabase.storage_progress": info<{ objects: number; fixed: number }>(
		msg({
			id: "{objects, plural, one {# storage object checked} other {# storage objects checked}}, {fixed} repaired so far",
		}),
	),
	"supabase.storage_checked": success<{
		objects: number;
		fixed: number;
		ok: number;
	}>(
		msg({
			id: "Storage files: {objects, plural, one {# object} other {# objects}} checked, {fixed} repaired, {ok} already complete",
		}),
	),
	"supabase.storage_repaired": warning<{ fixed: number }>(
		msg({
			id: "{fixed, plural, one {# storage file had} other {# storage files had}} no extended attributes (an archive made before backups kept them) and {fixed, plural, one {was} other {were}} repaired from the database",
		}),
	),
	"supabase.storage_missing": warning<{ count: number }>(
		msg({
			id: "Warning: {count, plural, one {# storage object has} other {# storage objects have}} no file on disk",
		}),
	),
	"supabase.storage_unsafe": warning<{ count: number }>(
		msg({
			id: "Warning: {count, plural, one {# storage object was} other {# storage objects were}} skipped (unsafe name, symlink or path outside the storage folder)",
		}),
	),
	"supabase.storage_failed": warning<{ count: number }>(
		msg({
			id: "Warning: the extended attributes of {count, plural, one {# storage file} other {# storage files}} could not be set",
		}),
	),
	"supabase.storage_check_failed": warning<Err>(
		msg({
			id: "Warning: the storage files could not be checked ({error}). Run Repair storage metadata on the app's API tab.",
		}),
	),

	// Cloud sync (import of a hosted project into a new app)
	"cloud_sync.opened": info<{
		project: string;
		region: string;
		product: string;
		version: string;
	}>(msg({ id: "Cloud project {project} ({region}), {product} {version}" })),
	"cloud_sync.deploying": info(
		msg({ id: "Deploying the new app before the import..." }),
	),
	"cloud_sync.part": info<{ part: string }>(msg({ id: "Importing: {part}" })),
	"cloud_sync.local_version": info<{ version: number; client: string }>(
		msg({ id: "The app runs Postgres {version}; dump and load with {client}" }),
	),
	"cloud_sync.dumping": info<{ kind: string }>(
		msg({ id: "Dumping the cloud database ({kind})..." }),
	),
	"cloud_sync.dumped": info<{ kind: string; size: CodedValue }>(
		msg({ id: "Dumped {kind}: {size}" }),
	),
	"cloud_sync.writers_stopping": info<{ services: CodedValue }>(
		msg({ id: "Stopping {services} while the database loads..." }),
	),
	"cloud_sync.key_installed": info(
		msg({ id: "Installed the project's Vault encryption key" }),
	),
	"cloud_sync.loading": info(msg({ id: "Loading roles, schema and data..." })),
	"cloud_sync.loaded": info<{ errors: number }>(
		msg({
			id: "Database loaded ({errors, plural, =0 {no SQL errors} one {# SQL error} other {# SQL errors}})",
		}),
	),
	"cloud_sync.sql_warning": warning<{ line: string }>(
		msg({ id: "SQL: {line}" }),
	),
	"cloud_sync.writers_started": info<{ services: CodedValue }>(
		msg({ id: "Started {services} again" }),
	),
	"cloud_sync.bucket": info<{ bucket: string; objects: number }>(
		msg({
			id: "Copying bucket {bucket} ({objects, plural, one {# object} other {# objects}})...",
		}),
	),
	"cloud_sync.bucket_done": info<{ bucket: string; copied: number }>(
		msg({
			id: "Bucket {bucket}: {copied, plural, one {# file} other {# files}} copied",
		}),
	),
	"cloud_sync.function": info<{ name: string; files: number }>(
		msg({
			id: "Edge function {name}: {files, plural, one {# file} other {# files}}",
		}),
	),
	"cloud_sync.function_skipped": warning<{ name: string; reason: CodedValue }>(
		msg({ id: "Edge function {name} skipped: {reason}" }),
	),
	"cloud_sync.cron_copied": info<{ copied: number; total: number }>(
		msg({
			id: "Cron jobs: {copied} of {total, plural, one {# job} other {# jobs}} re-created",
		}),
	),
	"cloud_sync.cron_skipped": info(
		msg({ id: "Cron jobs are not copied (as chosen)" }),
	),
	"cloud_sync.row_mismatch": warning<{
		table: string;
		source: number;
		target: number;
	}>(
		msg({ id: "Rows differ in {table}: {source} in the cloud, {target} here" }),
	),
	"cloud_sync.verified": info<{ tables: number; mismatches: number }>(
		msg({
			id: "Compared {tables, plural, one {# table} other {# tables}}: {mismatches, plural, =0 {all row counts match} one {# differs} other {# differ}}",
		}),
	),
	"appwrite_sync.waiting_api": info(
		msg({ id: "Waiting for the Appwrite API of the new app..." }),
	),
	"appwrite_sync.console_account": info<{ email: string }>(
		msg({
			id: "Console admin account {email} is ready (its password is in the app's secrets)",
		}),
	),
	"appwrite_sync.project_created": info<{ project: string }>(
		msg({ id: "Created project {project} in the new app" }),
	),
	"appwrite_sync.key_created": info(
		msg({ id: "Created a temporary API key for the migration" }),
	),
	"appwrite_sync.migration_started": info<{
		migration: string;
		resources: CodedValue;
	}>(msg({ id: "Migration {migration} started: {resources}" })),
	"appwrite_sync.migration_progress": info<{
		migration_stage: string;
		done: number;
		total: number;
	}>(msg({ id: "Migration {migration_stage}: {done} of {total} resources" })),
	"appwrite_sync.migration_retry": warning<{ error: CodedValue }>(
		msg({ id: "The migration failed ({error}); retrying once..." }),
	),
	"appwrite_sync.migration_error": warning<{
		resource: string;
		message: string;
	}>(msg({ id: "Migration error ({resource}): {message}" })),
	"appwrite_sync.migrated": info<{ success: number; errors: number }>(
		msg({
			id: "Migration finished: {success, plural, one {# resource} other {# resources}} copied, {errors, plural, =0 {no errors} one {# error} other {# errors}}",
		}),
	),
	"appwrite_sync.resource_mismatch": warning<{
		resource: string;
		source: number;
		target: number;
	}>(
		msg({
			id: "{resource}: {source} in the cloud, {target} copied",
		}),
	),
	"appwrite_sync.cleanup_failed": warning<{ error: CodedValue }>(
		msg({
			id: "The temporary API key or console session could not be removed: {error}",
		}),
	),
	"cloud_sync.done": success<{ project: string; app: string }>(
		msg({ id: "SUCCESS: imported {project} into {app}" }),
	),
	// Cloud sync export (an app into an empty cloud project)
	"cloud_sync.export_empty": info<{ project: string }>(
		msg({ id: "The cloud project {project} is empty" }),
	),
	"cloud_sync.export_part": info<{ part: string }>(
		msg({ id: "Exporting: {part}" }),
	),
	"cloud_sync.export_dumping": info<{ kind: string }>(
		msg({ id: "Dumping the app's database ({kind})..." }),
	),
	"cloud_sync.export_writers_stopping": info<{ services: CodedValue }>(
		msg({ id: "Stopping {services} while the app is copied..." }),
	),
	"cloud_sync.export_loading": info(
		msg({ id: "Loading roles, schema and data into the cloud project..." }),
	),
	"cloud_sync.function_deployed": info<{ name: string; files: number }>(
		msg({
			id: "Edge function {name} deployed to the cloud project ({files, plural, one {# file} other {# files}})",
		}),
	),
	"cloud_sync.export_row_mismatch": warning<{
		table: string;
		source: number;
		target: number;
	}>(
		msg({ id: "Rows differ in {table}: {source} here, {target} in the cloud" }),
	),
	"appwrite_sync.export_signed_in": info<{ email: string }>(
		msg({ id: "Signed in to this app's console as {email}" }),
	),
	"appwrite_sync.export_key_created": info<{ project: string }>(
		msg({
			id: "Created a temporary read-only API key in project {project} for the cloud to read",
		}),
	),
	"appwrite_sync.export_given_key": info<{ project: string }>(
		msg({ id: "Using the API key given for project {project}" }),
	),
	"appwrite_sync.export_resource_mismatch": warning<{
		resource: string;
		source: number;
		target: number;
	}>(msg({ id: "{resource}: {source} in this app, {target} copied" })),
	"appwrite_sync.export_cleanup_failed": warning<{ error: CodedValue }>(
		msg({
			id: "The cloud's migration record or the temporary API key could not be removed: {error}",
		}),
	),
	"cloud_sync.export_done": success<{ project: string; app: string }>(
		msg({ id: "SUCCESS: exported {app} to {project}" }),
	),
	"setup.checking_root": info(
		msg({ id: "Checking root privileges and base packages..." }),
	),
	"setup.detected": info<{ os: string; arch: string; kernel: string }>(
		msg({ id: "Detected {os} ({arch}), kernel {kernel}" }),
	),
	"setup.packages_present": info(
		msg({ id: "Required system packages are already installed" }),
	),
	"setup.packages_installing": info(
		msg({ id: "Installing required system packages..." }),
	),
	"setup.packages_installed": info(
		msg({ id: "Required system packages are installed" }),
	),
	"setup.docker_present": info<{ version: string }>(
		msg({ id: "Docker is already present (v{version})" }),
	),
	"setup.docker_installing": info(
		msg({ id: "Installing Docker CE and dependencies via apt..." }),
	),
	"setup.docker_installed": success<{ version: string }>(
		msg({ id: "Docker CE installed (v{version})" }),
	),
	"setup.network_ensuring": info<{ network: string }>(
		msg({ id: "Ensuring {network} exists..." }),
	),
	"setup.network_ready": info<{ network: string; driver: string }>(
		msg({ id: "{network} is ready ({driver})" }),
	),
	"setup.tunnel_network_ready": info<{ network: string }>(
		msg({ id: "{network} is ready" }),
	),
	"setup.traefik_dirs": info(msg({ id: "Preparing Traefik directories..." })),
	"setup.traefik_configs": info(
		msg({ id: "Writing Traefik static and middleware configs..." }),
	),
	"setup.traefik_current": info<{ version: string }>(
		msg({ id: "Traefik {version} is up to date and running" }),
	),
	"setup.traefik_pulling": info<{ image: string }>(
		msg({ id: "Pulling {image}..." }),
	),
	"setup.traefik_starting": info<{ container: string; image: string }>(
		msg({ id: "Starting {container} ({image})..." }),
	),
	"setup.traefik_running": info<{ version: string }>(
		msg({ id: "Traefik {version} reverse proxy running on ports 80 and 443" }),
	),
	"setup.traefik_running_tunnel": info<{ version: string }>(
		msg({
			id: "Traefik {version} running without public ports (Cloudflare Tunnel only)",
		}),
	),
	"setup.gathering": info(msg({ id: "Gathering system information..." })),
	"setup.takeover": warning<{ owners: CodedValue }>(
		msg({ id: "Taking over this server from {appName} instance {owners}" }),
	),
	"setup.tunnel_only": info(
		msg({
			id: "Cloudflare Tunnel only: ports 80 and 443 are not needed (Traefik publishes none)",
		}),
	),
	"setup.traefik_existing": info(
		msg({
			id: "Existing Traefik container found; converging its configuration",
		}),
	),
	"setup.ports_ok": info(msg({ id: "Ports 80 and 443 are available" })),
	"setup.docker_engine_installing": info(
		msg({ id: "Installing Docker Engine..." }),
	),
	"setup.docker_engine_installed": info<{ version: string }>(
		msg({ id: "Docker installed (v{version})" }),
	),
	"setup.docker_engine_present": info<{ version: string }>(
		msg({ id: "Docker already installed (v{version})" }),
	),
	"setup.traefik_setup": info(
		msg({ id: "Setting up the Traefik reverse proxy..." }),
	),
	"setup.done": success(
		msg({
			id: "SUCCESS: Server bootstrap completed. All required services are installed.",
		}),
	),
	"server.checking_local": info(msg({ id: "Checking the local host..." })),
	"server.connecting": info<{ target: string }>(
		msg({ id: "Connecting to {target}..." }),
	),
	"server.local_reachable": success(msg({ id: "Local host is reachable." })),
	"server.reachable": success(
		msg({ id: "SSH handshake succeeded. Server is reachable." }),
	),
	"server.os": info<{ os: string }>(msg({ id: "Operating system: {os}" })),
	"server.docker_found": info<{ version: string }>(
		msg({ id: "Docker found: v{version}" }),
	),
	"server.docker_missing": info(
		msg({ id: "Docker is not installed yet (bootstrap installs it)." }),
	),
	"server.bootstrap_local": info<{ server: string }>(
		msg({ id: "Starting bootstrap on {server} (local host)..." }),
	),
	"server.bootstrap_remote": info<{ server: string; host: string }>(
		msg({ id: "Starting bootstrap on {server} ({host})..." }),
	),
	"server.managed_key_installing": info(
		msg({
			id: "Installing managed SSH key (replacing password authentication)...",
		}),
	),
	"server.managed_key_installed": success(
		msg({ id: "Managed SSH key installed; password removed from {appName}" }),
	),
	"tunnel.traefik_private": info(
		msg({ id: "Tunnel only: recreating Traefik without public ports..." }),
	),
	"tunnel.traefik_public": info(
		msg({ id: "Publishing Traefik on ports 80 and 443 again..." }),
	),
	"tunnel.traefik_check": info(
		msg({ id: "Checking Traefik's tunnel entrypoint..." }),
	),
	"tunnel.routes_next": info(
		msg({
			id: "Routes of the server's apps are rewritten next (when the server is idle).",
		}),
	),
	"tunnel.status": info<{ state: string }>(
		msg({
			id: "Tunnel status: {state, select, connected {connected} connecting {connecting} failing {failing} stopped {not running} other {not configured}}",
		}),
	),
	"tunnel.applied": success(
		msg({ id: "SUCCESS: Cloudflare Tunnel settings applied" }),
	),
	"tunnel.writing_token": info(
		msg({ id: "Writing the Cloudflare Tunnel token (0600)..." }),
	),
	"tunnel.current": info(msg({ id: "cloudflared is up to date" })),
	"tunnel.started": info(msg({ id: "cloudflared started" })),
	"orphan.removing": info<{ folder: string }>(
		msg({ id: "Removing containers and volumes of {folder}..." }),
	),
	"orphan.wiped": success<{ folder: string }>(
		msg({ id: "SUCCESS: {folder} wiped" }),
	),
	"move.rolling_back": warning(
		msg({ id: "Rolling back: the app stays on the source server..." }),
	),
	"move.target_copy_left": warning<{ server: string; error: CodedValue }>(
		msg({
			id: "Warning: could not remove the copy on {server}: {error} (wipe it from the server's Settings → Orphaned app data)",
		}),
	),
	"move.restarting_source": info<{ app: string; server: string }>(
		msg({ id: "Starting {app} again on {server}..." }),
	),
	"move.backing_up": info<{ app: string; server: string }>(
		msg({ id: "Backing up {app} on {server}..." }),
	),
	"move.stopping_source": info<{ app: string; server: string }>(
		msg({ id: "Stopping {app} on {server} until the move is done..." }),
	),
	"move.domains_repointed": info<{ ip: string; hosts: CodedValue }>(
		msg({ id: "Free domains re-pointed at {ip}: {hosts}" }),
	),
	"move.deploying": info<{ app: string; server: string }>(
		msg({ id: "Deploying {app} on {server}..." }),
	),
	"move.removing_source": info<{ server: string }>(
		msg({ id: "Removing the copy on {server}..." }),
	),
	"move.source_copy_left": warning<{ server: string; error: CodedValue }>(
		msg({
			id: "Warning: the app moved, but {server} still has its old copy: {error} (wipe it from the server's Settings → Orphaned app data)",
		}),
	),
	"move.dns_hint": warning<{
		hosts: CodedValue;
		address: CodedValue;
		server: string;
	}>(
		msg({
			id: "DNS: point {hosts} at {address} (the A/AAAA records still lead to {server})",
		}),
	),
	"move.done": success<{ app: string; server: string }>(
		msg({ id: "SUCCESS: {app} now runs on {server}" }),
	),
	"backup.starting": info<{
		app: string;
		template: string;
		version: string;
		destination: string;
	}>(
		msg({ id: "Backing up {app} ({template} {version}) to {destination}..." }),
	),
	"backup.pre_hook": info<{ service: string }>(
		msg({ id: "Running pre-backup hook in {service}..." }),
	),
	"backup.post_hook": info<{ service: string }>(
		msg({ id: "Running post-backup hook in {service}..." }),
	),
	"backup.stopping_before_dump": info<{
		services: CodedValue;
		database: string;
	}>(
		msg({
			id: "Stopping {services} before dumping {database}, so the dump holds every acknowledged write...",
		}),
	),
	"backup.dumping": info<{ strategy: string }>(
		msg({ id: "Dumping the database ({strategy})..." }),
	),
	"backup.stopping": info<{ services: CodedValue }>(
		msg({ id: "Stopping {services} for a consistent copy..." }),
	),
	"backup.archiving_path": info<{ path: string }>(
		msg({ id: "Archiving {path}..." }),
	),
	"backup.archiving_volume": info<{ volume: string }>(
		msg({ id: "Archiving volume {volume}..." }),
	),
	"backup.leaving_stopped": info<{ services: CodedValue }>(
		msg({ id: "Leaving {services} stopped (the app is being moved)" }),
	),
	"backup.restarting": info<{ services: CodedValue }>(
		msg({ id: "Starting {services} again..." }),
	),
	"backup.compressing": info(msg({ id: "Compressing..." })),
	"backup.uploading": info<{ size: CodedValue }>(
		msg({ id: "Uploading {size}..." }),
	),
	"backup.stored": success<{ key: string; sha256: string }>(
		msg({ id: "Backup stored as {key} (sha256 {sha256}…)" }),
	),
	"backup.retention_failed": warning<{ path: string; detail: string }>(
		msg({ id: "Warning: could not delete {path}: {detail}" }),
	),
	"backup.retention_removed": info<{ path: string }>(
		msg({ id: "Retention: removed {path}" }),
	),
	"self_backup.dumping": info(msg({ id: "Dumping the {appName} database..." })),
	"self_backup.checksum": info<{ sha256: string }>(
		msg({ id: "sha256 {sha256} (check it before decrypting)" }),
	),
	"self_backup.stored": success<{ key: string; command: string }>(
		msg({ id: "Stored as {key}. Decrypt with: {command}" }),
	),
	"self_backup.done": success(
		msg({ id: "SUCCESS: {appName} backup completed" }),
	),
	"sweep.starting": info(
		msg({ id: "Removing leftover backup staging folders..." }),
	),
	"sweep.removed": info<{ path: string }>(msg({ id: "Removed {path}" })),
	"sweep.kept": warning<{ path: string }>(
		msg({ id: "Warning: {path} is used by a running job, kept" }),
	),
	"sweep.done": success<{ count: number }>(
		msg({
			id: "SUCCESS: removed {count, plural, one {# folder} other {# folders}}",
		}),
	),
	"sweep.nothing": success(msg({ id: "SUCCESS: nothing to remove" })),
	"network_migration.scanning": info<{ network: string }>(
		msg({
			id: "Looking for app containers registered on {network} under their service names...",
		}),
	),
	"network_migration.reconnecting": info<{ count: number }>(
		msg({
			id: "Re-attaching {count, plural, one {# container} other {# containers}} by container name only (each one is unreachable through the proxy for under a second)...",
		}),
	),
	"network_migration.reconnected": info<{ container: string }>(
		msg({ id: "Re-attached {container}" }),
	),
	"network_migration.failed": warning<{ container: string }>(
		msg({ id: "Warning: could not re-attach {container}" }),
	),
	"network_migration.done": success<{ count: number }>(
		msg({
			id: "SUCCESS: {count, plural, one {# container} other {# containers}} re-attached",
		}),
	),
	"network_migration.nothing": success(
		msg({ id: "SUCCESS: no container needed it" }),
	),
	"network_migration.files_refreshed": info<{ app: string }>(
		msg({
			id: "{app}: files rewritten without the shared networks (nothing restarted)",
		}),
	),
	"network_migration.files_skipped": warning<{ app: string }>(
		msg({
			id: "{app}: files left as they are (the app has changes waiting for a redeploy, or is not deployed): redeploy it to finish the network fix",
		}),
	),
	"network_migration.files_failed": warning<{ app: string } & Err>(
		msg({
			id: "{app}: could not rewrite its files ({error}): redeploy it to finish the network fix",
		}),
	),
	"backup.done": success(msg({ id: "SUCCESS: backup completed" })),
	"backup.first": info<{ app: string }>(
		msg({ id: "Backing up {app} first..." }),
	),
	"link.joined": info<{ database: string; network: string }>(
		msg({ id: "{database} joined {network}" }),
	),
	"link.done": success<{ app: string }>(
		msg({
			id: "SUCCESS: linked. Redeploy {app} to give it the connection variables.",
		}),
	),
	"link.redeploying": info<{ app: string }>(
		msg({ id: "Redeploying {app} with the connection variables..." }),
	),
	"unlink.left": info<{ database: string; network: string; app: string }>(
		msg({ id: "{database} left {network}: {app} can't reach it any more" }),
	),
	"unlink.done": success<{ app: string }>(
		msg({
			id: "SUCCESS: unlinked. Redeploy {app} to remove the connection variables.",
		}),
	),
	"unlink.redeploying": info<{ app: string }>(
		msg({ id: "Redeploying {app} without the connection variables..." }),
	),
	"unlink.network_removed": info<{ network: string }>(
		msg({ id: "Removed {network}" }),
	),
	"link.networks_ready": info<{ count: number }>(
		msg({ id: "Database link networks ready ({count})" }),
	),
	"link.removed": info<{ network: string }>(
		msg({ id: "Database link {network} removed" }),
	),
	"database.console_login": info(
		msg({ id: "Setting up the console's read-only login..." }),
	),
	"build.fetching_commit": info<{ url: string; commit: string }>(
		msg({ id: "Fetching {url} ({commit})..." }),
	),
	"build.fetching_branch": info<{ url: string; branch: string }>(
		msg({ id: "Fetching {url} (branch {branch})..." }),
	),
	"build.commit": info<{ commit: string; author: string; message: string }>(
		msg({ id: "Commit {commit} by {author}: {message}" }),
	),
	"build.submodules": info<{ count: number }>(
		msg({
			id: "Fetching {count, plural, one {# submodule} other {# submodules}}...",
		}),
	),
	"build.submodules_skipped": warning(
		msg({
			id: "Warning: the repository has submodules; they are not fetched (turn on submodules in Source settings)",
		}),
	),
	"build.already_built": info<{ image: string }>(
		msg({ id: "Image {image} is already built." }),
	),
	"build.builder_detected": info<{ builder: string; detected: string }>(
		msg({ id: "Builder: {builder} (detected: {detected})" }),
	),
	"build.builder": info<{ builder: string }>(msg({ id: "Builder: {builder}" })),
	"build.buildkit": info<{
		memory: CodedValue;
		cpus: number;
		timeout: CodedValue;
	}>(
		msg({
			id: "Preparing BuildKit (limits: {memory}, {cpus} CPU, {timeout})...",
		}),
	),
	"build.building": info<{ image: string }>(msg({ id: "Building {image}..." })),
	"build.built": success<{ image: string; duration: CodedValue }>(
		msg({ id: "Built {image} in {duration}" }),
	),
	"build.using_image": info<{ image: string }>(
		msg({ id: "Using image {image}" }),
	),
	"build.image_missing": info<{ image: string }>(
		msg({ id: "Image {image} is not on this server: building it..." }),
	),
	"build.retention": info<{ keep: number; remove: number }>(
		msg({ id: "Image retention: keeping {keep}, removing {remove}..." }),
	),
	"build.removing_images": info(
		msg({ id: "Removing the app's built images..." }),
	),
	"build.stopped_app": info<{ commit: string }>(
		msg({
			id: "The app is stopped: {commit} is built but not deployed (deploy it from the Deployments tab).",
		}),
	),
	"build.deploying": info<{ commit: string }>(
		msg({ id: "Deploying {commit}..." }),
	),
	"update.rollback_redeploy": info<{ version: string }>(
		msg({ id: "Rolling back: deploying {version} again..." }),
	),
	"update.rollback_restore": info(
		msg({
			id: "Rolling back: restoring the backup taken before the update...",
		}),
	),
	"update.stopped_early": info(
		msg({ id: "The update stopped before the running version was replaced." }),
	),
	"update.no_rollback_backup": warning(
		msg({
			id: "No automatic rollback: this app's updates are undone by restoring a backup, and none was taken. Restore one from the Backups tab.",
		}),
	),
	"update.no_rollback_manual": warning(
		msg({
			id: "No automatic rollback for this app (template: rollback = manual). Fix it or restore a backup from the Backups tab.",
		}),
	),
	"update.rollback_error": failure<{ error: CodedValue }>(
		msg({ id: "ERROR: rollback failed: {error}" }),
	),
	"update.rolled_back": success<{ app: string; version: string }>(
		msg({ id: "Rolled back: {app} runs {version} again." }),
	),
	"update.rollback_failed": failure(
		msg({
			id: "ERROR: the rollback did not succeed; the app needs attention.",
		}),
	),
	"panel.route_removed": success(msg({ id: "SUCCESS: panel route removed" })),
	"panel.connecting": info<{ network: string }>(
		msg({ id: "Connecting Traefik and the panel through {network}..." }),
	),
	"panel.routed": success<{ url: string }>(
		msg({ id: "SUCCESS: {url} now routes to the panel" }),
	),
	"panel.env_hint": info<{ appUrl: string; bind: string }>(
		msg({ id: "Set {appUrl} and {bind}, then restart {appName}." }),
	),
	"task.output_truncated": warning<{ max: number }>(
		msg({
			id: "Output truncated after {max} lines: see the run's output in Scheduled tasks → Run history.",
		}),
	),
	"task.running": info<{ task: string; service: string }>(
		msg({ id: "Running task {task} in {service}..." }),
	),
	"task.no_sh": warning(
		msg({
			id: "No sh in the image: the command runs without an in-container timeout.",
		}),
	),
	"task.done": success<{ task: string }>(
		msg({ id: "SUCCESS: {task} finished" }),
	),
	"upgrade.starting": info<{ from: string; to: string; image: string }>(
		msg({ id: "Upgrading {appName} {from} → {to} ({image})." }),
	),
	"upgrade.notes": info<{ url: string }>(msg({ id: "Release notes: {url}" })),
	"upgrade.db_note": warning(
		msg({
			id: "Note: the database is migrated by the new version and is not rolled back automatically; the self-backup below is the way back.",
		}),
	),
	"upgrade.step_backup": info(
		msg({ id: "Step 1/3: {appName} self-backup (required)..." }),
	),
	"upgrade.step_pull": info<{ image: string }>(
		msg({ id: "Step 2/3: pulling {image}..." }),
	),
	"upgrade.step_updater": info(
		msg({ id: "Step 3/3: starting the updater; this panel restarts now." }),
	),
	"upgrade.phase": info<{ phase: string }>(
		msg({
			id: "— {phase, select, preflight {checks} backup {backup} pull {pull} handoff {handoff} switching {switching} health {health check} rolling_back {rolling back} succeeded {succeeded} rolled_back {rolled back} other {failed}} —",
		}),
	),
	"upgrade.succeeded": success<{ to: string; panel: string }>(
		msg({ id: "SUCCESS: {appName} {to} is running (this panel: {panel})." }),
	),
	"upgrade.rolled_back": warning<{ from: string }>(
		msg({
			id: "{appName} {from} is running again. If the new version migrated the database before failing, restore the self-backup taken at the start (README: disaster recovery).",
		}),
	),
	"upgrade.unknown_state": failure(
		msg({
			id: "The panel may be down or on an unknown version: check `docker compose ps` in the install folder.",
		}),
	),
	"upgrade.panel_network": warning<{ error: CodedValue }>(
		msg({ id: "Warning: panel route network: {error}" }),
	),
	"upgrade.following": info<{ version: string }>(
		msg({ id: "{appName} {version} started; following the updater..." }),
	),
	"upgrade.updater_line": info<{ line: string }>(
		msg({ id: "updater: {line}" }),
	),
} satisfies Record<string, LogEventDef<Params>>;

export type JobLogEvent = keyof typeof jobLogEvents;
type JobLogParams<E extends JobLogEvent> =
	(typeof jobLogEvents)[E] extends LogEventDef<infer P> ? P : never;
/** Params argument of `ctx.event(code, ...)`: optional when there are none. */
export type JobLogArgs<E extends JobLogEvent> =
	keyof JobLogParams<E> extends never
		? [params?: JobLogParams<E>]
		: [params: JobLogParams<E>];

/** A log event's text in the reader's language; null for unknown codes. */
export function logEventText(
	i18n: I18n,
	code: string,
	params: Record<string, unknown> | null | undefined,
): string | null {
	const def = lookup(jobLogEvents, code);
	if (!def) return null;
	const values = formatCodedParams(i18n, params);
	for (const [name, registry] of Object.entries(keyParams)) {
		const label = lookup(registry, String(params?.[name] ?? ""));
		if (label) values[name] = i18n._(label);
	}
	return i18n._({ ...def.message, values });
}

/** Level of a log event (line color); null for unknown codes. */
export function logEventLevel(code: string): LogLevel | null {
	return lookup(jobLogEvents, code)?.level ?? null;
}
