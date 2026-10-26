import { describe, expect, it } from "vitest";
import {
	GitUrlError,
	gitPort,
	isRelativeSubmoduleUrl,
	parseGitUrl,
	resolveGitHost,
} from "./url";

const pub = { allowPrivate: false };
const priv = { allowPrivate: true };

function reason(fn: () => unknown): string | null {
	try {
		fn();
		return null;
	} catch (error) {
		return error instanceof GitUrlError ? error.reason : "other";
	}
}

describe("parseGitUrl", () => {
	it("accepts https, ssh and scp-like URLs", () => {
		expect(parseGitUrl("https://github.com/acme/app.git", pub)).toMatchObject({
			protocol: "https",
			host: "github.com",
			port: null,
			path: "/acme/app.git",
			url: "https://github.com/acme/app.git",
		});
		expect(parseGitUrl("git@gitlab.com:acme/group/app.git", pub)).toMatchObject(
			{
				protocol: "ssh",
				user: "git",
				host: "gitlab.com",
				url: "ssh://git@gitlab.com/acme/group/app.git",
			},
		);
		expect(
			parseGitUrl("ssh://git@git.example.org:2222/acme/app.git", pub),
		).toMatchObject({ protocol: "ssh", port: 2222 });
		expect(gitPort(parseGitUrl("https://h.example.com:8443/a/b", pub))).toBe(
			8443,
		);
		expect(gitPort(parseGitUrl("git@h.example.com:a/b", pub))).toBe(22);
	});

	it("refuses other protocols and local paths", () => {
		for (const url of [
			"file:///etc/passwd",
			"git://github.com/acme/app.git",
			"ext::sh -c id",
			"ftp://example.com/repo.git",
		]) {
			expect(reason(() => parseGitUrl(url, priv))).not.toBeNull();
		}
		expect(reason(() => parseGitUrl("/srv/repo.git", priv))).toBe("invalid");
		expect(reason(() => parseGitUrl("./repo", priv))).toBe("invalid");
	});

	it("allows http only for private hosts", () => {
		expect(reason(() => parseGitUrl("http://git.example.com/a/b", pub))).toBe(
			"protocol",
		);
		expect(parseGitUrl("http://10.0.0.5:3000/a/b.git", priv).protocol).toBe(
			"http",
		);
	});

	it("refuses credentials in the URL", () => {
		expect(
			reason(() => parseGitUrl("https://user:pass@github.com/a/b.git", pub)),
		).toBe("credentials");
		expect(
			reason(() => parseGitUrl("https://token@github.com/a/b.git", pub)),
		).toBe("credentials");
	});

	it("refuses option injection, traversal, queries and shell characters", () => {
		for (const url of [
			"-uhttps://github.com/a/b",
			"https://github.com/-a/b",
			"https://github.com/a/../../b",
			"https://github.com/a/b?x=1",
			"https://github.com/a/b#frag",
			"https://github.com/a/b;id",
			"https://github.com/a/$(id)",
			"git@-oProxyCommand=id:a/b",
			"git@host:-x/b",
			"https://-host.com/a/b",
		]) {
			expect(
				reason(() => parseGitUrl(url, priv)),
				url,
			).not.toBeNull();
		}
	});

	it("refuses private and local hosts unless allowed", () => {
		for (const url of [
			"https://127.0.0.1/a/b",
			"https://localhost/a/b",
			"https://169.254.169.254/a/b",
			"https://[::1]/a/b",
			"git@10.1.2.3:a/b.git",
			"https://2130706433/a/b",
		]) {
			expect(
				reason(() => parseGitUrl(url, pub)),
				url,
			).toBe("private");
		}
		expect(parseGitUrl("https://192.168.1.10/a/b", priv).host).toBe(
			"192.168.1.10",
		);
	});
});

describe("resolveGitHost (SSRF guard)", () => {
	const url = parseGitUrl("https://git.example.com/a/b.git", pub);
	const resolver =
		(...addresses: string[]) =>
		async () =>
			addresses.map((address) => ({ address }));

	it("pins a public address", async () => {
		await expect(
			resolveGitHost(url, {
				allowPrivate: false,
				resolve: resolver("1.2.3.4"),
			}),
		).resolves.toEqual({ address: "1.2.3.4" });
	});

	it("refuses names resolving to private addresses (any of them)", async () => {
		await expect(
			resolveGitHost(url, {
				allowPrivate: false,
				resolve: resolver("1.2.3.4", "10.0.0.1"),
			}),
		).rejects.toMatchObject({ reason: "private" });
		await expect(
			resolveGitHost(url, {
				allowPrivate: false,
				resolve: resolver("::ffff:127.0.0.1"),
			}),
		).rejects.toMatchObject({ reason: "private" });
	});

	it("refuses unresolvable names unless private hosts are allowed", async () => {
		const failing = async () => {
			throw new Error("ENOTFOUND");
		};
		await expect(
			resolveGitHost(url, { allowPrivate: false, resolve: failing }),
		).rejects.toMatchObject({ reason: "unresolved" });
		await expect(
			resolveGitHost(url, { allowPrivate: true, resolve: failing }),
		).resolves.toEqual({ address: null });
	});
});

describe("submodule URLs", () => {
	it("recognises relative submodules only", () => {
		expect(isRelativeSubmoduleUrl("../lib.git")).toBe(true);
		expect(isRelativeSubmoduleUrl("./x/y")).toBe(true);
		expect(isRelativeSubmoduleUrl("../-x")).toBe(false);
		expect(isRelativeSubmoduleUrl("https://x/y")).toBe(false);
		expect(isRelativeSubmoduleUrl("/abs")).toBe(false);
	});
});
