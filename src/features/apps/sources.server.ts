import {
	type AppSourceKind,
	appSourceKindOf,
	appSources,
} from "#/config/app-sources.ts";
import type { db } from "#/db/index.ts";
import type { Actor } from "#/features/auth/access.ts";
import type { JobContext } from "#/features/deployments/deployments.server.ts";
import type { ServerRow } from "#/features/servers/schema.ts";
import {
	customManifest,
	type TemplateManifest,
} from "#/features/templates/schema.ts";
import { assertCustomSpec } from "#/features/templates/templates.server.ts";
import type { ErrorCode } from "#/libs/error-codes.ts";
import type { AppLocation } from "#/server/services/apps/commands.ts";
import type { Executor } from "#/server/services/executor.ts";
import {
	inlineRenderInput,
	type RenderedTemplate,
	type RenderInput,
} from "#/server/services/templates/render.ts";
import { AppError } from "#/utils/error.ts";
import { readCustomSpec } from "./apps.server";
import type { AppRow, CreateAppInput } from "./schema";

/**
 * Server side of the app source registry (`#/config/app-sources.ts`): how
 * each kind of app is turned into what the shared deploy pipeline runs.
 * The pipeline (render → upload → policy → prepare → up → health) is the
 * same for every kind; a driver only supplies the effective manifest, the
 * files to render and optional steps around it (e.g. git builds the image
 * in `prepare`). A new source = a driver here, never edits in the jobs.
 */

/** What a source contributes instead of fetching upstream files. */
type SourceRenderInput = Pick<
	RenderInput,
	"manifest" | "files" | "overlay" | "extraDefaults" | "version" | "commitSha"
>;

/** App fields a driver may read (a restore preview has no id). */
export type SourceApp = Pick<AppRow, "templateId" | "customSpecEncrypted"> &
	Partial<
		Pick<
			AppRow,
			| "id"
			| "folder"
			| "commitSha"
			| "serverId"
			| "teamId"
			| "version"
			| "inputs"
			| "envEncrypted"
		>
	>;

/** What a deploy job asks of an owner-defined source (git). */
export interface SourceRequest {
	/** Commit to deploy (default: the app's current one). */
	commitSha?: string;
	/** Build the image when missing (false: a rollback never builds). */
	allowBuild?: boolean;
	/** Release row prepared by the job (build metadata already known). */
	trigger?: "manual" | "webhook" | "rollback" | "redeploy";
}

interface SourceStepInput {
	executor: Executor;
	location: AppLocation;
	app: AppRow;
	server: ServerRow;
	rendered: RenderedTemplate;
	ctx: JobContext;
	request: SourceRequest;
}

/** Transaction of the app's creation (rows written with the app). */
type CreateTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The create request of an app of the driver's kind. */
export interface CreateRequest {
	actor: Actor;
	template: TemplateManifest;
	input: CreateAppInput;
}

/** What a driver decides for a new app (validated, nothing stored yet). */
export interface PreparedCreate {
	/** The effective manifest (inputs are checked against its variables). */
	manifest: TemplateManifest;
	/** Version the app starts at (undefined: the request's or the template's default). */
	version?: string;
	/** The app's overrides (undefined: the request's non-empty inputs). */
	overrides?: Record<string, string>;
	/** Rows written with the app, in its creation transaction. */
	persist?(tx: CreateTx, appId: string): Promise<void>;
}

export interface AppSourceDriver {
	kind: AppSourceKind;
	/**
	 * Field of the create request this kind reads (`custom`, `git`,
	 * `database`); sent for another kind, the request is refused.
	 */
	createField?: SourceCreateField;
	/** Validate a create request and shape the new app (default: the template as is). */
	prepareCreate?(request: CreateRequest): Promise<PreparedCreate>;
	/** The manifest that applies to an app of this kind. */
	manifest(base: TemplateManifest, app: SourceApp): Promise<TemplateManifest>;
	/**
	 * Files to render (null = fetch the template's upstream files at the
	 * pinned version). `commitSha` is the commit being deployed, if known.
	 */
	renderInput(
		base: TemplateManifest,
		app: SourceApp,
		/**
		 * `commitSha`: the commit being deployed, if known. `version`: the
		 * version an update moves to (default: the app's).
		 */
		options: { commitSha?: string; version?: string },
	): Promise<SourceRenderInput | null>;
	/**
	 * Before the rendered files are written (git: build the image), so a
	 * failure leaves the running app's files untouched. The rendered
	 * compose has passed the raw policy check already.
	 */
	prepare?(input: SourceStepInput): Promise<void>;
	/** After the app is healthy (records, cleanup). */
	afterDeploy?(input: SourceStepInput): Promise<void>;
	/** While an app is torn down on a server (extra artifacts). */
	teardown?(input: {
		executor: Executor;
		app: AppRow;
		removeImages: boolean;
		ctx: JobContext;
	}): Promise<void>;
}

const templateDriver: AppSourceDriver = {
	kind: "template",
	manifest: async (base) => base,
	renderInput: async () => null,
};

const customComposeDriver: AppSourceDriver = {
	kind: "custom-compose",
	createField: "custom",
	prepareCreate: async ({ template, input }) => {
		if (!input.custom) throw new AppError("TEMPLATE_COMPOSE_REQUIRED");
		assertCustomSpec(input.custom, template.id);
		return { manifest: customManifest(template, input.custom) };
	},
	manifest: async (base, app) => {
		const spec = readCustomSpec(app);
		return spec ? customManifest(base, spec) : base;
	},
	renderInput: async (base, app) => {
		const spec = readCustomSpec(app);
		if (!spec) return null;
		return inlineRenderInput(base, spec);
	},
};

const drivers: Record<AppSourceKind, () => Promise<AppSourceDriver>> = {
	template: async () => templateDriver,
	"custom-compose": async () => customComposeDriver,
	// Lazy: the git driver imports the deploy jobs, which import this.
	git: async () =>
		(await import("#/features/git/driver.server.ts")).gitSourceDriver,
	database: async () =>
		(await import("#/features/databases/driver.server.ts"))
			.databaseSourceDriver,
};

/** Create request fields owned by one kind, and the refusal for the others. */
const SOURCE_CREATE_FIELDS = {
	custom: "TEMPLATE_NOT_INLINE",
	git: "TEMPLATE_NOT_GIT",
	database: "TEMPLATE_NOT_DATABASE",
} as const satisfies Record<string, ErrorCode>;
type SourceCreateField = keyof typeof SOURCE_CREATE_FIELDS;

/**
 * Validate a create request with the template's driver: fields of other
 * kinds are refused, the driver shapes the manifest, version and rows.
 */
export async function prepareCreate(
	request: CreateRequest,
): Promise<PreparedCreate> {
	const driver = await sourceDriver(request.template);
	for (const [field, code] of Object.entries(SOURCE_CREATE_FIELDS) as [
		SourceCreateField,
		(typeof SOURCE_CREATE_FIELDS)[SourceCreateField],
	][]) {
		if (request.input[field] !== undefined && driver.createField !== field) {
			throw new AppError(code);
		}
	}
	return driver.prepareCreate
		? driver.prepareCreate(request)
		: { manifest: request.template };
}

export function sourceKindOf(manifest: TemplateManifest): AppSourceKind {
	return appSourceKindOf(manifest.source.type);
}

export async function sourceDriver(
	manifest: TemplateManifest,
): Promise<AppSourceDriver> {
	return drivers[sourceKindOf(manifest)]();
}

/** Whether apps of this template have upstream versions. */
export function isVersionedSource(manifest: TemplateManifest): boolean {
	return appSources[sourceKindOf(manifest)].versioned;
}
