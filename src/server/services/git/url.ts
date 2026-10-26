import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateHost } from "#/config/ip-ranges.ts";
import { GIT_URL_MAX_LENGTH } from "#/features/git/schema.ts";

/**
 * Repository URLs of git apps (pure parsing + an SSRF check). The clone
 * runs on the app's server, so a URL pointing at its private network (or a
 * cloud metadata address) would make Nitrobase fetch from there: hosts must
 * resolve to public addresses unless the owner allowed a private host.
 *
 * Accepted:
 * - `https://host[:port]/path` (no user info, query or fragment);
 * - `ssh://[user@]host[:port]/path` and scp-like `user@host:path` (deploy
 *   key only);
 * - `http://` only with "private host" allowed (a self-hosted Git server
 *   on the same network).
 * Everything else (`file:`, `git://`, `ext::`, local paths, options) is
 * refused, and so is any part starting with `-` (option injection).
 */
type GitProtocol = "https" | "http" | "ssh";

export interface GitUrl {
	protocol: GitProtocol;
	host: string;
	/** null = protocol default. */
	port: number | null;
	/** SSH user (scp-like/ssh URLs). */
	user: string | null;
	/** Path on the host, starting with `/` for URLs, as given for scp-like. */
	path: string;
	/** The URL passed to git (scp-like form normalised to `ssh://`). */
	url: string;
}

export class GitUrlError extends Error {
	constructor(
		readonly reason:
			| "invalid"
			| "protocol"
			| "credentials"
			| "private"
			| "unresolved",
	) {
		super(`Invalid repository URL (${reason})`);
		this.name = "GitUrlError";
	}
}

const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/i;
const PATH = /^\/?[A-Za-z0-9._~@+%/-]{1,400}$/;

function checkPath(path: string): string {
	const parts = path.split("/").filter(Boolean);
	if (
		!PATH.test(path) ||
		parts.length === 0 ||
		parts.some((part) => part === ".." || part === "." || part.startsWith("-"))
	) {
		throw new GitUrlError("invalid");
	}
	return path;
}

function checkHost(raw: string): string {
	const host = raw.replace(/^\[|\]$/g, "").toLowerCase();
	if (isIP(host)) return host;
	if (!HOST.test(host)) throw new GitUrlError("invalid");
	return host;
}

/** Parse and validate a repository URL (no DNS). */
export function parseGitUrl(
	input: string,
	options: { allowPrivate: boolean },
): GitUrl {
	const value = input.trim();
	if (
		!value ||
		value.length > GIT_URL_MAX_LENGTH ||
		/[\s\0'"\\`$;|&<>]/.test(value) ||
		/(^|[/:])\.\.?(\/|$)/.test(value) ||
		value.startsWith("-")
	) {
		throw new GitUrlError("invalid");
	}
	// scp-like: user@host:path (no scheme, no "//").
	const scp = /^([^@/:]+)@([^@/:[\]]+):(?!\/\/)(.+)$/.exec(value);
	if (scp && !value.includes("://")) {
		const [, user, host, path] = scp;
		if (!USER.test(user)) throw new GitUrlError("invalid");
		const cleanHost = checkHost(host);
		const cleanPath = checkPath(path.startsWith("/") ? path : `/${path}`);
		return finish(
			{
				protocol: "ssh",
				host: cleanHost,
				port: null,
				user,
				path: cleanPath,
			},
			options,
		);
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new GitUrlError("invalid");
	}
	const scheme = url.protocol.replace(/:$/, "");
	if (scheme !== "https" && scheme !== "http" && scheme !== "ssh") {
		throw new GitUrlError("protocol");
	}
	if (scheme === "http" && !options.allowPrivate) {
		throw new GitUrlError("protocol");
	}
	if (url.password || (url.username && scheme !== "ssh")) {
		throw new GitUrlError("credentials");
	}
	if (url.search || url.hash) throw new GitUrlError("invalid");
	if (scheme === "ssh" && url.username && !USER.test(url.username)) {
		throw new GitUrlError("invalid");
	}
	return finish(
		{
			protocol: scheme,
			host: checkHost(url.hostname),
			port: url.port ? Number(url.port) : null,
			user: scheme === "ssh" ? url.username || "git" : null,
			path: checkPath(decodeURIComponent(url.pathname)),
		},
		options,
	);
}

function finish(
	parts: Omit<GitUrl, "url">,
	options: { allowPrivate: boolean },
): GitUrl {
	if (!options.allowPrivate && isPrivateHost(parts.host)) {
		throw new GitUrlError("private");
	}
	const host = isIP(parts.host) === 6 ? `[${parts.host}]` : parts.host;
	const port = parts.port ? `:${parts.port}` : "";
	const url =
		parts.protocol === "ssh"
			? `ssh://${parts.user ?? "git"}@${host}${port}${parts.path}`
			: `${parts.protocol}://${host}${port}${parts.path}`;
	return { ...parts, url };
}

/** Default port of a protocol (pinning and display). */
export function gitPort(url: GitUrl): number {
	return (
		url.port ??
		(url.protocol === "ssh" ? 22 : url.protocol === "http" ? 80 : 443)
	);
}

/** Relative submodule URLs (`../x.git`) resolve against the repository. */
export function isRelativeSubmoduleUrl(value: string): boolean {
	return /^\.\.?\/[A-Za-z0-9._~@+/-]+$/.test(value) && !value.includes("/-");
}

/**
 * Resolve the host and pick the address the clone is pinned to. Without
 * "private host" allowed, every resolved address must be public (a name
 * resolving to both is refused: DNS answers can rotate).
 */
export async function resolveGitHost(
	url: GitUrl,
	options: {
		allowPrivate: boolean;
		resolve?: (host: string) => Promise<{ address: string }[]>;
	},
): Promise<{ address: string | null }> {
	if (isIP(url.host)) {
		if (!options.allowPrivate && isPrivateHost(url.host)) {
			throw new GitUrlError("private");
		}
		return { address: url.host };
	}
	const resolve =
		options.resolve ??
		((name: string) => lookup(name, { all: true, verbatim: true }));
	let addresses: { address: string }[];
	try {
		addresses = await resolve(url.host);
	} catch {
		if (options.allowPrivate) return { address: null };
		throw new GitUrlError("unresolved");
	}
	if (addresses.length === 0) {
		if (options.allowPrivate) return { address: null };
		throw new GitUrlError("unresolved");
	}
	if (options.allowPrivate) return { address: null };
	if (addresses.some((item) => isPrivateHost(item.address))) {
		throw new GitUrlError("private");
	}
	return { address: addresses[0].address };
}
