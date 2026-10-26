/**
 * Client-safe constants shared by UI and server validation. Server-only,
 * env-backed settings live in `#/config/server.ts`.
 */
/** Product name (a brand, not translated). */
export const APP_NAME = "Nitrobase";
/**
 * Machine id of the brand: self-backup files, in-process markers, and the
 * prefix of machine identifiers (`RESOURCE_PREFIX` in
 * `#/config/identifiers.ts`).
 */
export const APP_ID = "nitrobase";
/**
 * GitHub repository (`owner/name`) of the official releases: the panel's
 * update check (RELEASE_REPO default) and scripts/install.sh (--repo
 * default) use it; release images are `ghcr.io/<repo lowercased>`.
 */
export const RELEASE_REPO_DEFAULT = "AydenGroup/nitrobase";
/** Image tag variable of the panel install's `.env` (installer, updater). */
export const VERSION_ENV_NAME = "NITROBASE_VERSION";

export const PASSWORD_MIN_LENGTH = 8;
/** Lifetime of the cookie remembering the chosen language (one year). */
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
/** Prefilled SSH connection fields of a new server. */
export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_SSH_USERNAME = "root";
/**
 * Row of the default server (the machine the panel runs on), created at
 * registration. Commands run locally, so host/port/user are placeholders;
 * the UI shows "This machine" instead of them.
 */
export const LOCAL_SERVER = {
	name: "Localhost",
	host: "local",
	port: 0,
	username: "root",
} as const;
/**
 * Example values of placeholders and hints (reserved example domain, RFC
 * 2606): one place, so every form shows the same ones.
 */
export const EXAMPLES = {
	appHost: "app.example.com",
	panelHost: "panel.example.com",
	email: "you@example.com",
} as const;

/** Longest name of a user-named item (app, database, destination, channel). */
export const NAME_MAX_LENGTH = 80;
/** Longest period counted in days (retention, token lifetime). */
export const MAX_DAYS = 3650;

/** Backup schedule and retention: defaults and bounds (form and server). */
export const BACKUP_POLICY = {
	/** Every day at 03:00 in the scheduler's time zone. */
	defaultCron: "0 3 * * *",
	defaultKeepLast: 7,
	maxKeepLast: 1000,
} as const;

/** Schedule a new scheduled task starts with. */
export const TASK_DEFAULT_CRON = "0 3 * * *";

/** Longest accepted profile avatar URL. */
export const AVATAR_URL_MAX_LENGTH = 2048;

/** Only same-origin relative paths are accepted as post-login redirects. */
export function safeRedirectPath(value: unknown, fallback = "/"): string {
	if (typeof value !== "string") return fallback;
	if (
		!value.startsWith("/") ||
		value.startsWith("//") ||
		value.includes("\\")
	) {
		return fallback;
	}
	try {
		const url = new URL(value, "http://local.invalid");
		if (url.origin !== "http://local.invalid") return fallback;
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return fallback;
	}
}
