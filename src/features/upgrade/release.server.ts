import { getConfig } from "#/config/server.ts";
import { APP_NAME } from "#/config/shared.ts";
import { APP_VERSION } from "#/config/version.ts";
import { getSetting } from "#/features/settings/settings.server.ts";
import { dbCache } from "#/features/templates/templates.server.ts";
import { errorInfoOf } from "#/server/services/error-info.ts";
import { schedule } from "#/server/services/scheduler.ts";
import {
	type CacheStore,
	createGitHubClient,
	type RawRelease,
} from "#/server/services/templates/github.ts";
import {
	isNewerRelease,
	pickLatestRelease,
	sendsGitHubToken,
} from "#/server/services/upgrade/releases.ts";
import type { InstanceUpdateStatus } from "./schema";

/**
 * "Is there a newer Nitrobase?": the releases of RELEASE_REPO through the
 * GitHub API (or a Gitea/Forgejo host with the same API, RELEASE_API_URL),
 * cached in the GitHub cache table for UPDATE_CHECK_CACHE_MS, with the
 * GitHub token only when talking to GitHub itself.
 */

function releaseApi(): { apiUrl: string; github: boolean } {
	const config = getConfig();
	const apiUrl = (config.RELEASE_API_URL ?? config.GITHUB_API_URL).replace(
		/\/+$/,
		"",
	);
	return { apiUrl, github: sendsGitHubToken(apiUrl, config.GITHUB_API_URL) };
}

/** Cache keys include the API host: the same path on Gitea is another repo. */
function prefixedCache(prefix: string): CacheStore {
	return {
		get: (key) => dbCache.get(`${prefix}${key}`),
		set: (key, entry) => dbCache.set(`${prefix}${key}`, entry),
	};
}

export async function fetchReleases(refresh = false): Promise<RawRelease[]> {
	const config = getConfig();
	const repo = config.RELEASE_REPO;
	const { apiUrl, github } = releaseApi();
	const client = createGitHubClient({
		apiUrl,
		rawUrl: config.GITHUB_RAW_URL,
		// Never send the GitHub token to another host.
		token: github ? await getSetting("github.token") : undefined,
		cache: prefixedCache(`release:${apiUrl}`),
		ttlMs: refresh ? 0 : config.UPDATE_CHECK_CACHE_MS,
		timeoutMs: config.GITHUB_TIMEOUT_MS,
	});
	return client.listReleases(repo);
}

export async function getInstanceUpdate(
	options: { refresh?: boolean } = {},
): Promise<InstanceUpdateStatus> {
	const config = getConfig();
	const base = {
		current: APP_VERSION,
		channel: config.RELEASE_CHANNEL,
		repo: config.RELEASE_REPO,
		latest: null,
		available: false,
		error: null,
	};
	if (!config.UPDATE_CHECK_ENABLED) return { ...base, check: "disabled" };
	try {
		const releases = await fetchReleases(options.refresh);
		const latest = pickLatestRelease(releases, config.RELEASE_CHANNEL);
		return {
			...base,
			check: "ok",
			latest,
			available: isNewerRelease(APP_VERSION, latest),
		};
	} catch (error) {
		return {
			...base,
			check: "error",
			error: errorInfoOf(error),
		};
	}
}

/** Refresh the release list periodically (the banner then reads the cache). */
export function registerUpdateCheck(): void {
	const config = getConfig();
	if (!config.UPDATE_CHECK_ENABLED) return;
	schedule("instance-update-check", config.UPDATE_CHECK_CRON, async () => {
		const status = await getInstanceUpdate({ refresh: true });
		if (status.available && status.latest) {
			console.info(
				`[upgrade] ${APP_NAME} ${status.latest.version} is available (running ${status.current})`,
			);
		}
	});
}

/** "Install on a VPS" guide: DOCS_INSTALL_URL, the repository README, else this panel's /api/install.sh. */
export function installGuideUrl(): string {
	const config = getConfig();
	if (config.DOCS_INSTALL_URL) return config.DOCS_INSTALL_URL;
	const repo = config.RELEASE_REPO;
	if (repo) {
		const api = (config.RELEASE_API_URL ?? config.GITHUB_API_URL).replace(
			/\/+$/,
			"",
		);
		if (api === config.GITHUB_API_URL.replace(/\/+$/, "")) {
			return `${config.GITHUB_WEB_URL.replace(/\/+$/, "")}/${repo}${config.DOCS_INSTALL_ANCHOR}`;
		}
		if (/\/api\/v1$/.test(api)) {
			return `${api.replace(/\/api\/v1$/, "")}/${repo}${config.DOCS_INSTALL_ANCHOR}`;
		}
	}
	return "/api/install.sh";
}
