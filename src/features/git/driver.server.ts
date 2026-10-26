import { and, eq, inArray } from "drizzle-orm";
import { getConfig } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { appGitSources, appReleases } from "#/db/schema/git.ts";
import type { AppSourceDriver } from "#/features/apps/sources.server.ts";
import {
	appImagesCommand,
	removeAppImagesScript,
} from "#/server/services/git/commands.ts";
import {
	GIT_VERSION,
	gitImageTag,
	gitManifest,
	gitRenderInput,
} from "#/server/services/git/compose.ts";
import {
	imagesToPrune,
	prunedReleaseIds,
} from "#/server/services/git/retention.ts";
import { AppError } from "#/utils/error.ts";
import { buildCommit, ownImageExists } from "./build.server";
import { insertGitSource, prepareGitSource } from "./git.server";

/**
 * App source driver of git apps: the manifest and compose come from the
 * app's runtime settings, `prepare` makes sure the image of the commit
 * being deployed exists on the target server (building it when allowed:
 * first deploys, moves and restores rebuild; a rollback never does), and
 * `afterDeploy` applies image retention.
 */

async function runtimeOf(appId: string | undefined) {
	if (!appId) return null;
	const [row] = await db
		.select({
			runtime: appGitSources.runtime,
			keepImages: appGitSources.keepImages,
		})
		.from(appGitSources)
		.where(eq(appGitSources.appId, appId))
		.limit(1);
	return row ?? null;
}

export const gitSourceDriver: AppSourceDriver = {
	kind: "git",
	createField: "git",
	// The repository is checked (URL, SSRF, credential) before anything is
	// stored; its source row is written with the app.
	async prepareCreate({ actor, template, input }) {
		if (!input.git) throw new AppError("TEMPLATE_REPOSITORY_REQUIRED");
		const spec = input.git;
		const prepared = await prepareGitSource(actor, spec);
		return {
			manifest: gitManifest(template, spec.runtime),
			version: GIT_VERSION,
			overrides: { ...(spec.env ?? {}) },
			persist: (tx, appId) => insertGitSource(tx, actor, appId, prepared),
		};
	},
	async manifest(base, app) {
		const row = await runtimeOf(app.id);
		return row ? gitManifest(base, row.runtime) : base;
	},
	async renderInput(base, app, options) {
		const row = await runtimeOf(app.id);
		const commitSha = options.commitSha;
		if (!row || !commitSha || !app.folder) return null;
		return gitRenderInput(base, {
			folder: app.folder,
			commitSha,
			runtime: row.runtime,
		});
	},
	async prepare({ executor, app, rendered, ctx, request }) {
		const tag = gitImageTag(app.folder, rendered.commitSha);
		if (await ownImageExists(executor, tag, app.id)) {
			ctx.event("build.using_image", { image: tag });
			return;
		}
		if (request.allowBuild === false) {
			await db
				.update(appReleases)
				.set({ status: "pruned", updatedAt: new Date() })
				.where(
					and(
						eq(appReleases.appId, app.id),
						eq(appReleases.commitSha, rendered.commitSha),
					),
				);
			throw new AppError("GIT_IMAGE_MISSING", { image: tag });
		}
		ctx.event("build.image_missing", { image: tag });
		await buildCommit({ executor, app, commitSha: rendered.commitSha, ctx });
	},
	async afterDeploy({ executor, app, rendered, ctx }) {
		const now = new Date();
		await db
			.update(appReleases)
			.set({ lastDeployedAt: now, status: "ready", updatedAt: now })
			.where(
				and(
					eq(appReleases.appId, app.id),
					eq(appReleases.commitSha, rendered.commitSha),
				),
			);
		const row = await runtimeOf(app.id);
		const config = getConfig();
		const keep = Math.min(
			row?.keepImages ?? config.GIT_KEEP_IMAGES,
			config.GIT_KEEP_IMAGES_MAX,
		);
		const listed = await executor.exec(appImagesCommand(app.id));
		if (listed.exitCode !== 0) return;
		const present = listed.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const releases = await db
			.select()
			.from(appReleases)
			.where(eq(appReleases.appId, app.id));
		// Releases whose image is gone (moved server, manual cleanup).
		const missing = releases
			.filter(
				(release) =>
					release.status === "ready" &&
					release.commitSha !== rendered.commitSha &&
					!present.includes(release.imageTag),
			)
			.map((release) => release.id);
		const prune = imagesToPrune({
			folder: app.folder,
			present,
			releases,
			liveSha: rendered.commitSha,
			keep,
		});
		const script = removeAppImagesScript(prune);
		let removed: string[] = [];
		if (script) {
			ctx.event("build.retention", { keep, remove: prune.length });
			const result = await executor.exec(script);
			removed = result.stdout
				.split("\n")
				.filter((line) => line.startsWith("removed "))
				.map((line) => line.slice("removed ".length).trim());
			for (const line of result.stdout.split("\n").filter(Boolean)) {
				ctx.log(line);
			}
		}
		const ids = [...missing, ...prunedReleaseIds(releases, removed)];
		if (ids.length) {
			await db
				.update(appReleases)
				.set({ status: "pruned", updatedAt: now })
				.where(inArray(appReleases.id, ids));
		}
	},
	async teardown({ executor, app, removeImages, ctx }) {
		if (!removeImages) return;
		const listed = await executor.exec(appImagesCommand(app.id));
		const tags = listed.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((tag) => tag.startsWith(`${app.folder}:`));
		const script = removeAppImagesScript(tags);
		if (!script) return;
		ctx.event("build.removing_images");
		const result = await executor.exec(script);
		for (const line of result.stdout.split("\n").filter(Boolean)) ctx.log(line);
	},
};
