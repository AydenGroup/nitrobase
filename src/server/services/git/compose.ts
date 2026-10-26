import { stringify as stringifyYaml } from "yaml";
import {
	GIT_APP_SERVICE,
	type RuntimeSettings,
} from "#/features/git/schema.ts";
import type { TemplateManifest } from "#/features/templates/schema.ts";
import type { RenderInput } from "#/server/services/templates/render.ts";
import { internalError } from "#/utils/error.ts";
import { assertImageTag } from "./commands";

/**
 * Runtime of a git app (pure): a one-service compose running the built
 * image. It is rendered by the same `renderFromFiles` as every template, so
 * the compose transform, the policy, routes, resource limits, owner labels
 * and backups apply unchanged; nothing here relaxes them.
 */

/** Version label of git apps (the commit is the real version). */
export const GIT_VERSION = "git";

/** Image of an app at a commit: `<app folder>:<sha>`. */
export function gitImageTag(folder: string, commitSha: string): string {
	if (!/^[0-9a-f]{40}$/.test(commitSha)) {
		throw internalError("Invalid commit SHA");
	}
	return assertImageTag(`${folder}:${commitSha}`);
}

/** The compose file of a git app at `imageTag`. */
function gitComposeYaml(imageTag: string, runtime: RuntimeSettings): string {
	const service: Record<string, unknown> = {
		image: assertImageTag(imageTag),
		// Built on this server: never pulled from a registry.
		pull_policy: "never",
		restart: "unless-stopped",
		environment: { PORT: String(runtime.port) },
	};
	if (runtime.volumes.length) {
		service.volumes = runtime.volumes.map(
			(volume) => `${volume.name}:${volume.mountPath}`,
		);
	}
	const compose: Record<string, unknown> = {
		services: { [GIT_APP_SERVICE]: service },
	};
	if (runtime.volumes.length) {
		compose.volumes = Object.fromEntries(
			runtime.volumes.map((volume) => [volume.name, {}]),
		);
	}
	return stringifyYaml(compose, { lineWidth: 0 });
}

/**
 * The effective manifest of a git app: the `git` template's with one route
 * to the app's port, the owner's health path and the declared volumes
 * backed up (services stopped while archived).
 */
export function gitManifest(
	manifest: TemplateManifest,
	runtime: RuntimeSettings,
): TemplateManifest {
	return {
		...manifest,
		domains: [
			{
				service: GIT_APP_SERVICE,
				port: runtime.port,
				primary: true,
				https: true,
				paths: [],
			},
		],
		health: runtime.healthPath
			? {
					...manifest.health,
					service: GIT_APP_SERVICE,
					port: runtime.port,
					path: runtime.healthPath,
				}
			: manifest.health
				? { ...manifest.health, path: undefined }
				: undefined,
		backup: {
			...manifest.backup,
			paths: [],
			volumes: runtime.volumes.map((volume) => volume.name),
			stop: true,
			database: undefined,
		},
	};
}

/** Render input of a git app at a commit (`source.type = "git"`). */
export function gitRenderInput(
	manifest: TemplateManifest,
	input: { folder: string; commitSha: string; runtime: RuntimeSettings },
): Pick<
	RenderInput,
	"manifest" | "files" | "overlay" | "extraDefaults" | "version" | "commitSha"
> {
	return {
		manifest: gitManifest(manifest, input.runtime),
		files: [
			{
				path: manifest.source.compose,
				content: Buffer.from(
					gitComposeYaml(
						gitImageTag(input.folder, input.commitSha),
						input.runtime,
					),
				),
				executable: false,
			},
		],
		overlay: null,
		extraDefaults: {},
		version: GIT_VERSION,
		commitSha: input.commitSha,
	};
}
