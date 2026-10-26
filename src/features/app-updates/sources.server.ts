import type { AppSourceKind } from "#/config/app-sources.ts";
import {
	canUpgradeInPlace,
	databaseEngines,
	parseDatabaseVersion,
} from "#/config/database-engines.ts";
import { getAppServer } from "#/features/apps/apps.server.ts";
import type { AppRow } from "#/features/apps/schema.ts";
import type {
	JobContext,
	JobOutcome,
} from "#/features/deployments/deployments.server.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import type { TemplateManifest } from "#/features/templates/schema.ts";
import { getTemplateVersions } from "#/features/templates/templates.server.ts";
import {
	commitUrlTemplate,
	isTemplateTarget,
	newerCommit,
	newerDatabaseVersion,
	newerTemplateVersion,
	type UpdateCandidate,
} from "#/server/services/app-updates/candidates.ts";
import type { RollbackMode } from "#/server/services/app-updates/policy.ts";
import { AppError } from "#/utils/error.ts";

/**
 * Where updates come from and how they are applied, per app source kind
 * (`#/config/app-sources.ts`). A source kind without versions maps to
 * null; a new kind must decide here (compile error otherwise).
 */
export interface UpdateSourceDriver {
	/** Label of what runs now. */
	current(app: AppRow): string;
	/** Newest version newer than the deployed one (null: up to date). */
	latest(
		app: AppRow,
		manifest: TemplateManifest,
		options: { refresh: boolean },
	): Promise<UpdateCandidate | null>;
	rollback(app: AppRow, manifest: TemplateManifest): RollbackMode;
	/** Refuse a target this source cannot move to (before the job starts). */
	assertTarget?(
		app: AppRow,
		version: string,
		manifest: TemplateManifest,
	): Promise<void> | void;
	/** Deploy `version` (inside the update job). */
	apply(app: AppRow, version: string, ctx: JobContext): Promise<JobOutcome>;
	/** Deploy `previous` again (rollback `redeploy`). */
	redeploy(previous: AppRow, ctx: JobContext): Promise<JobOutcome>;
}

// Lazy: the deploy jobs import the source registry, which this mirrors.
const appJobs = () => import("#/features/apps/app-jobs.server.ts");

const templateUpdates: UpdateSourceDriver = {
	current: (app) => app.version,
	async latest(app, manifest, options) {
		const { versions } = await getTemplateVersions(app.templateId, {
			refresh: options.refresh,
		});
		return newerTemplateVersion({
			versions,
			current: app.version,
			currentCommit: app.commitSha,
			commits: manifest.source.versions === "commits",
		});
	},
	rollback: (_app, manifest) => manifest.updates.rollback,
	async assertTarget(app, version, manifest) {
		const { versions } = await getTemplateVersions(app.templateId, {
			includePrereleases: true,
		});
		if (
			!isTemplateTarget({
				versions,
				current: app.version,
				currentCommit: app.commitSha,
				commits: manifest.source.versions === "commits",
				target: version,
			})
		) {
			throw new AppError("APP_UPDATE_NONE");
		}
	},
	async apply(app, version, ctx) {
		return (await appJobs()).runDeploy(app.id, "update", version, ctx);
	},
	async redeploy(previous, ctx) {
		// A failed deploy never stores its version: the row still names the
		// previous version and pinned commit.
		return (await appJobs()).runDeploy(previous.id, "redeploy", undefined, ctx);
	},
};

function databaseOf(app: AppRow) {
	const parsed = parseDatabaseVersion(app.version);
	if (!parsed) throw new AppError("APP_UPDATE_UNSUPPORTED");
	return parsed;
}

const databaseUpdates: UpdateSourceDriver = {
	current: (app) => parseDatabaseVersion(app.version)?.tag ?? app.version,
	async latest(app) {
		const { engine, tag } = databaseOf(app);
		return newerDatabaseVersion(engine, tag);
	},
	rollback: (app) => databaseEngines[databaseOf(app).engine].rollback,
	assertTarget(app, version) {
		const { engine, tag } = databaseOf(app);
		const target = parseDatabaseVersion(version);
		if (
			!target ||
			target.engine !== engine ||
			!canUpgradeInPlace(engine, tag, target.tag)
		) {
			throw new AppError("DATABASE_UPGRADE_NOT_ALLOWED", {
				from: tag,
				to: target?.tag ?? version,
			});
		}
	},
	async apply(app, version, ctx) {
		return (await appJobs()).runDeploy(app.id, "update", version, ctx);
	},
	async redeploy(previous, ctx) {
		return (await appJobs()).runDeploy(previous.id, "redeploy", undefined, ctx);
	},
};

const gitUpdates: UpdateSourceDriver = {
	current: (app) => app.commitSha?.slice(0, 12) ?? app.version,
	async latest(app) {
		const server = await getAppServer(app);
		if (server.status !== "ready") throw new AppError("SERVER_NOT_READY");
		const { remoteBranchTip } = await import("#/features/git/build.server.ts");
		const executor = await getExecutor(server);
		try {
			const tip = await remoteBranchTip(executor, app);
			if (!tip.sha) return null;
			return newerCommit({
				tip: tip.sha,
				deployed: app.commitSha,
				branch: tip.branch,
				commitUrl: commitUrlTemplate(tip.repoUrl),
			});
		} finally {
			executor.close();
		}
	},
	// The previous image is kept (GIT_KEEP_IMAGES): no rebuild needed.
	rollback: () => "redeploy",
	assertTarget(_app, version) {
		if (!/^[0-9a-f]{40}$/.test(version)) {
			throw new AppError("APP_UPDATE_UNSUPPORTED");
		}
	},
	async apply(app, version, ctx) {
		const { runBuildAndDeploy } = await import("#/features/git/git.server.ts");
		return runBuildAndDeploy(app.id, ctx, { commitSha: version });
	},
	async redeploy(previous, ctx) {
		if (!previous.commitSha) {
			return {
				success: false,
				error: new AppError("APP_UPDATE_NO_PREVIOUS_COMMIT"),
			};
		}
		return (await appJobs()).runDeploy(
			previous.id,
			"redeploy",
			undefined,
			ctx,
			{
				source: {
					commitSha: previous.commitSha,
					allowBuild: true,
					trigger: "rollback",
				},
			},
		);
	},
};

export const updateDrivers = {
	template: templateUpdates,
	"custom-compose": null,
	git: gitUpdates,
	database: databaseUpdates,
} satisfies Record<AppSourceKind, UpdateSourceDriver | null>;
