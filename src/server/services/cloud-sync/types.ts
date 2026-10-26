import type {
	CloudSyncProvider,
	PreflightCountUnit,
	SyncDirection,
	SyncPart,
} from "#/config/cloud-sync.ts";
import type { JobStep } from "#/config/job-log-events.ts";
import type {
	CloudConnectionTestRecord,
	CloudSyncSummary,
} from "#/db/schema/cloud-sync.ts";
import type { JobContext } from "#/features/deployments/deployments.server.ts";
import type { TemplateManifest } from "#/features/templates/schema.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import type { Executor } from "#/server/services/executor.ts";
import type { AppError, DetailErrorCode } from "#/utils/error.ts";

/**
 * Server driver of a cloud sync provider (#/config/cloud-sync.ts): tests a
 * connection, previews a sync and plans its steps. Steps act on the app
 * only through `SyncTarget`, so a driver never touches app rows, compose
 * files or paths itself. An export (direction "export") reads the app
 * through the same `SyncTarget` and writes to the cloud project, which
 * must be empty (`OpenedSync.assertEmpty`, checked again at job start).
 */
export interface CloudSyncDriver {
	test(
		provider: CloudSyncProvider,
		config: Record<string, unknown>,
	): Promise<Omit<CloudConnectionTestRecord, "at">>;
	/**
	 * The version the new app will run, as the preflight compares it with
	 * the cloud's (e.g. the template's Postgres major, or its release).
	 * Null: unknown until the app runs.
	 */
	targetVersion(probe: TemplateProbe): Promise<string | null>;
	preflight(
		provider: CloudSyncProvider,
		config: Record<string, unknown>,
		input: {
			direction: SyncDirection;
			parts: SyncPart[];
			target: SyncPreflightTarget;
			/** The app an export reads (export only). */
			source?: ExportSource;
			/** `provider.importSchema` values of this run (import only). */
			inputs?: Record<string, unknown>;
		},
	): Promise<CloudPreflight>;
	/**
	 * What the export modal can offer before the preflight (e.g. the app's
	 * projects when the panel can sign in to its console).
	 */
	exportOptions?(source: ExportSource): Promise<ExportOptions>;
	/**
	 * Values of the new app's editable variables an import sets (e.g. the
	 * console admin email), from the template's `[plugin]` config.
	 */
	importInputs?(input: {
		pluginConfig: unknown;
		/** Email of the member starting the import (null: a token). */
		email: string | null;
	}): Record<string, string>;
	/**
	 * Undo what an import step left in the app when the panel died during
	 * the job (`SyncRun.checkpoint` state: ids only, never secrets).
	 */
	recover?(input: {
		state: unknown;
		target: SyncTarget;
		/** The sync's connection, when it still exists (export clean-up). */
		connection?: {
			provider: CloudSyncProvider;
			config: Record<string, unknown>;
		};
	}): Promise<void>;
	/** Resolve the cloud project once and plan the steps of a sync. */
	open(
		provider: CloudSyncProvider,
		config: Record<string, unknown>,
		direction: SyncDirection,
		/** The app an export reads (export only). */
		source?: ExportSource,
		/** `provider.importSchema` values of this run (import only). */
		inputs?: Record<string, unknown>,
	): Promise<OpenedSync>;
}

/** The app an export reads, as the panel reaches it. */
export interface ExportSource {
	/** The app on its server (SQL, files, its API through the gateway). */
	target: SyncTarget;
	/** `https://<primary domain>` of the app (null: no HTTPS domain). */
	publicUrl: string | null;
	/** `provider.exportSchema` values (validated; secrets never stored). */
	inputs: Record<string, unknown>;
}

export interface ExportOptions {
	/** Projects of the app the export can read (null: cannot list them). */
	projects: { id: string; name: string }[] | null;
	/** The `exportSchema` field a picked project fills. */
	projectField?: string;
	/** `exportSchema` fields the modal does not need to ask. */
	hidden: string[];
}

/** The template an import deploys, before the app exists. */
export interface TemplateProbe {
	templateId: string;
	/** Release the app will deploy (null: none resolved). */
	version: string | null;
	manifest: TemplateManifest;
	/** The rendered compose file of that release. */
	compose(): Promise<string>;
}

/** What the panel knows about the target before the job. */
export interface SyncPreflightTarget {
	serverName: string;
	freeDiskBytes: number | null;
	/** `driver.targetVersion` (null: unknown until the app runs). */
	version: string | null;
	/** Template release the new app deploys (null: the latest). */
	release?: string | null;
}

/** One preflight row: what a part holds in the cloud. */
export interface PreflightContent {
	part: SyncPart;
	/** Size in bytes (null: not measured). */
	sizeBytes: number | null;
	counts: { unit: PreflightCountUnit; count: number; atLeast?: boolean }[];
	/** Names worth listing (e.g. functions). */
	names?: string[];
}

export interface CloudPreflight {
	direction?: SyncDirection;
	project: { id: string; name: string; region: string; status: string };
	/**
	 * Versions of `provider.versionLabel`: the cloud's (`source`) and the
	 * app's (`target`), whatever the direction.
	 */
	versions: { source: string; target: string | null };
	target: SyncPreflightTarget;
	/** What the copy reads (the cloud's for an import, the app's for an export). */
	contents: PreflightContent[];
	/** Export: what the cloud project already holds (all zero: empty). */
	cloud?: PreflightContent[];
	requiredDiskBytes: number;
	blockers: ErrorInfo[];
	warnings: ErrorInfo[];
}

export interface OpenedSync {
	/** Cloud project id (e.g. a Supabase project reference). */
	project: string;
	region: string;
	/** The cloud's version (`provider.versionLabel`). */
	version: string;
	/** Secrets learnt while preparing (keys): scrubbed from logs too. */
	secrets(): string[];
	/** Fetch what the steps need before the job changes anything. */
	prepare(parts: SyncPart[]): Promise<void>;
	/**
	 * Export: throw a coded error unless the cloud project is still empty
	 * (run at job start, before anything is written to it).
	 */
	assertEmpty?(): Promise<void>;
	steps(parts: SyncPart[]): SyncStep[];
}

export type StepFailure = DetailErrorCode | ((detail: string) => AppError);

/** The app a sync writes to (or reads from), as the job runner exposes it. */
export interface SyncTarget {
	executor: Executor;
	/** Staging folder on the server (0700, removed after the job). */
	workDir: string;
	appName: string;
	/** Template `[plugin]` config of the app. */
	pluginConfig: unknown;
	/** Current env values (secrets: server-only). */
	values: Record<string, string>;
	container(service: string): string;
	/** Run a command on the server; a non-zero exit throws `failure`. */
	run(
		command: string,
		failure: StepFailure,
		options?: { input?: string | Buffer; quiet?: boolean },
	): Promise<string>;
	/** `docker compose <args>` of the app. */
	compose(args: string[], failure: StepFailure): Promise<string>;
	/** Record stopped/started services (restarted by recovery after a crash). */
	servicesStopped(services: string[]): Promise<void>;
	servicesStarted(services: string[]): Promise<void>;
}

export interface SyncRun {
	/** Redacting job context. */
	job: JobContext;
	target: SyncTarget;
	parts: SyncPart[];
	summary: CloudSyncSummary;
	/** A tolerated problem: logged, counted and kept in the summary. */
	warn(warning: ErrorInfo): Promise<void>;
	/**
	 * Persist what `driver.recover` must undo if the panel dies now (ids
	 * only, never secrets); null once nothing is left to undo.
	 */
	checkpoint?(state: Record<string, unknown> | null): Promise<void>;
}

export interface SyncStep {
	id: string;
	/** The part it copies (null: verification). */
	part: SyncPart | null;
	/** Run as a step a cancel waits for. */
	critical?: JobStep;
	run(run: SyncRun): Promise<void>;
}
