import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { lookup } from "#/config/labels.ts";
import { jobTypeLabel } from "#/config/status.ts";
import {
	type CodedParams,
	type CodedValue,
	formatCodedParams,
} from "#/libs/coded.ts";

/**
 * Titles of jobs, rendered in the reader's language. A job stores its kind
 * (`type`, see `jobTypes`), the title key (`title_key`, null = the kind)
 * and the title params (`title_params`); `title` keeps a source-language
 * copy for API clients.
 */
export interface JobTitleDef<P> {
	message: MessageDescriptor;
	/** Type-only marker of the params (never set). */
	readonly params?: P;
}

function title<P extends CodedParams = Record<never, never>>(
	message: MessageDescriptor,
): JobTitleDef<NoInfer<P>> {
	return { message };
}

type App = { app: string };

export const jobTitles = {
	bootstrap: title(msg({ id: "Bootstrap server & Traefik" })),
	connection_test: title<{ target: string }>(msg({ id: "Test SSH: {target}" })),
	connection_test_local: title(msg({ id: "Test local Docker" })),
	terminal: title(msg({ id: "Terminal session" })),
	app_terminal: title(msg({ id: "Container terminal" })),
	app_deploy: title<App>(msg({ id: "Deploy {app}" })),
	app_redeploy: title<App>(msg({ id: "Redeploy {app}" })),
	app_redeploy_compose: title<App>(
		msg({ id: "Redeploy {app} (compose changed)" }),
	),
	app_rotate: title<{ name: string }>(msg({ id: "Rotate {name}" })),
	app_rotate_hook: title<{ name: string }>(
		msg({ id: "Run the follow-up step of the {name} rotation again" }),
	),
	app_update: title<App & { version: string }>(
		msg({ id: "Update {app} to {version}" }),
	),
	app_start: title<App>(msg({ id: "Start {app}" })),
	app_stop: title<App>(msg({ id: "Stop {app}" })),
	app_restart: title<App>(msg({ id: "Restart {app}" })),
	app_start_service: title<App & { service: string }>(
		msg({ id: "Start {service} of {app}" }),
	),
	app_stop_service: title<App & { service: string }>(
		msg({ id: "Stop {service} of {app}" }),
	),
	app_restart_service: title<App & { service: string }>(
		msg({ id: "Restart {service} of {app}" }),
	),
	app_service_env: title<{ service: string }>(
		msg({ id: "Update {service} secrets" }),
	),
	app_routes: title<App>(msg({ id: "Update routes for {app}" })),
	app_delete: title<App>(msg({ id: "Delete {app}" })),
	orphan_wipe: title<{ folder: string }>(msg({ id: "Wipe {folder}" })),
	panel_route: title(msg({ id: "Panel domain" })),
	app_backup: title<App>(msg({ id: "Back up {app}" })),
	app_restore_overwrite: title<App>(msg({ id: "Restore {app} in place" })),
	app_restore_clone: title<App>(msg({ id: "Restore {app} as a new app" })),
	app_move: title<App & { target: string }>(
		msg({ id: "Move {app} to {target}" }),
	),
	cloud_import: title<App & { project: string }>(
		msg({ id: "Import {project} into {app}" }),
	),
	supabase_storage_repair: title<App>(
		msg({ id: "Repair storage metadata of {app}" }),
	),
	cloud_export: title<App & { project: string }>(
		msg({ id: "Export {app} to {project}" }),
	),
	tunnel: title<{ server: string }>(
		msg({ id: "Cloudflare Tunnel on {server}" }),
	),
	panel_backup: title(msg({ id: "Back up {appName}" })),
	app_recover: title<{ services: CodedValue }>(
		msg({ id: "Recover {services}" }),
	),
	backup_verify: title<{ file: string }>(msg({ id: "Verify {file}" })),
	workdir_sweep: title<{ server: string }>(
		msg({ id: "Clean up leftovers on {server}" }),
	),
	network_migration: title<{ server: string }>(
		msg({ id: "Isolate app service names on {server}" }),
	),
	app_task: title<{ task: string }>(msg({ id: "Task {task}" })),
	app_build: title<App>(msg({ id: "Build and deploy {app}" })),
	app_rollback: title<App & { commit: string }>(
		msg({ id: "Roll back {app} to {commit}" }),
	),
	database_link: title<App & { database: string }>(
		msg({ id: "Link {app} to {database}" }),
	),
	database_unlink: title<App & { database: string }>(
		msg({ id: "Unlink {app} from {database}" }),
	),
	panel_upgrade: title<{ version: string }>(
		msg({ id: "Upgrade {appName} to {version}" }),
	),
} satisfies Record<string, JobTitleDef<CodedParams>>;

export type JobTitleKey = keyof typeof jobTitles;
export type JobTitleParams<K extends JobTitleKey> =
	(typeof jobTitles)[K] extends JobTitleDef<infer P> ? P : never;

/** What `startJob` takes: a title key and its params (type-checked). */
export type JobTitle = {
	[K in JobTitleKey]: keyof JobTitleParams<K> extends never
		? { key: K; params?: JobTitleParams<K> }
		: { key: K; params: JobTitleParams<K> };
}[JobTitleKey];

/** Build a typed job title. */
export function jobTitle<K extends JobTitleKey>(
	key: K,
	...params: keyof JobTitleParams<K> extends never
		? [JobTitleParams<K>?]
		: [JobTitleParams<K>]
): JobTitle {
	return { key, params: params[0] ?? {} } as JobTitle;
}

/** The parts of a job row its title is rendered from. */
export interface JobTitleSource {
	type: string;
	titleKey?: string | null;
	titleParams?: CodedParams | null;
}

/**
 * A job's title in the reader's language: its coded title, else the label
 * of its kind.
 */
export function titleFor(i18n: I18n, job: JobTitleSource): string {
	const def = lookup(jobTitles, job.titleKey ?? job.type);
	if (def) {
		return i18n._({
			...def.message,
			values: formatCodedParams(i18n, job.titleParams),
		});
	}
	return jobTypeLabel(i18n, job.type) || job.type;
}
