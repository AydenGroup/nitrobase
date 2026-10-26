import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const { clientCommand, connectionUrl, sshTunnelCommand } = await import(
	"./connection"
);
const { encodeUrlPart } = await import("./engines/common");
const {
	assertLinkEnvName,
	ensureLinkNetworksCommand,
	linkNetwork,
	pruneLinkNetworksCommand,
	removeLinkNetworkCommand,
	renderLinkEnv,
} = await import("./links");

const internal = { host: "database-0123abcd-db", port: 5432 };
const tricky = {
	user: "us er@x",
	password: "p@ss:w/rd?#%&'()*!",
	database: "my db/1",
};

describe("connection strings", () => {
	it("percent-encodes user, password and database", () => {
		expect(encodeUrlPart("a@b:c/d?#[]%'()*!")).toBe(
			"a%40b%3Ac%2Fd%3F%23%5B%5D%25%27%28%29%2A%21",
		);
		expect(connectionUrl("postgres", internal, tricky)).toBe(
			"postgresql://us%20er%40x:p%40ss%3Aw%2Frd%3F%23%25%26%27%28%29%2A%21@database-0123abcd-db:5432/my%20db%2F1",
		);
		const url = new URL(
			connectionUrl("mysql", { host: "10.0.0.5", port: 3306 }, tricky),
		);
		expect(decodeURIComponent(url.username)).toBe(tricky.user);
		expect(decodeURIComponent(url.password)).toBe(tricky.password);
		expect(decodeURIComponent(url.pathname.slice(1))).toBe(tricky.database);
	});

	it("leaves the password out when masked", () => {
		expect(
			connectionUrl("postgres", internal, { ...tricky, password: null }),
		).toBe("postgresql://us%20er%40x@database-0123abcd-db:5432/my%20db%2F1");
	});

	it("builds engine-specific URLs", () => {
		expect(
			connectionUrl(
				"valkey",
				{ host: "h", port: 6379 },
				{ user: null, password: "a/b", database: null },
			),
		).toBe("redis://default:a%2Fb@h:6379/0");
		expect(
			connectionUrl(
				"mongodb",
				{ host: "h", port: 27017 },
				{ user: "root", password: "x", database: "app" },
			),
		).toBe("mongodb://root:x@h:27017/app?authSource=admin");
		expect(
			connectionUrl(
				"postgres",
				{ host: "::1", port: 5432 },
				{ user: "a", password: null, database: "b" },
			),
		).toBe("postgresql://a@[::1]:5432/b");
	});

	it("client commands quote values and never contain the password", () => {
		const login = { user: "o'neil", database: "app" };
		expect(clientCommand("postgres", internal, login)).toBe(
			"psql -h 'database-0123abcd-db' -p 5432 -U 'o'\\''neil' -d 'app'",
		);
		expect(clientCommand("mariadb", internal, login)).toBe(
			"mariadb -h 'database-0123abcd-db' -P 5432 -u 'o'\\''neil' -p 'app'",
		);
		expect(
			clientCommand("valkey", internal, { user: null, database: null }),
		).toContain("--askpass");
		expect(
			clientCommand("mongodb", internal, { user: "root", database: "app" }),
		).toBe(
			"mongosh 'mongodb://root@database-0123abcd-db:5432/app?authSource=admin' --password",
		);
	});

	it("SSH tunnel hint", () => {
		expect(
			sshTunnelCommand({
				sshUser: "root",
				sshHost: "1.2.3.4",
				sshPort: 2222,
				hostPort: 15432,
				localPort: 15432,
			}),
		).toBe("ssh -N -L 15432:127.0.0.1:15432 -p 2222 'root@1.2.3.4'");
	});
});

describe("link env", () => {
	it("renders URL and parts, skipping empty parts", () => {
		expect(
			renderLinkEnv(
				"valkey",
				{ host: "h", port: 6379 },
				{ user: null, password: "pw", database: null },
				[
					{ name: "REDIS_URL", part: "url" },
					{ name: "REDIS_USER", part: "user" },
					{ name: "REDIS_PORT", part: "port" },
				],
			),
		).toEqual({ REDIS_URL: "redis://default:pw@h:6379/0", REDIS_PORT: "6379" });
	});

	it("refuses invalid and reserved names", () => {
		expect(assertLinkEnvName("DATABASE_URL")).toBe("DATABASE_URL");
		expect(() => assertLinkEnvName("COMPOSE_FILE")).toThrow();
		expect(() => assertLinkEnvName("lower")).toThrow();
	});
});

describe("link networks", () => {
	const id = "89abcdef-0000-4000-8000-00000000c0de";

	it("names, keys and services", () => {
		expect(linkNetwork(id, ["db"])).toEqual({
			key: "nitrobase_link_89abcdef00004000800000000000c0de",
			name: "nitrobase-link-89abcdef00004000800000000000c0de",
			services: ["db"],
		});
		expect(() => linkNetwork("../x", "all")).toThrow();
	});

	it("creates internal, labelled networks idempotently", () => {
		const command = ensureLinkNetworksCommand(
			[{ name: "nitrobase-link-89abcdef00004000800000000000c0de", linkId: id }],
			"inst-1",
		);
		expect(command).toContain(
			"docker network inspect 'nitrobase-link-89abcdef00004000800000000000c0de'",
		);
		expect(command).toContain(
			"docker network create --internal --label 'nitrobase.instance=inst-1' --label 'nitrobase.link=89abcdef00004000800000000000c0de'",
		);
		expect(ensureLinkNetworksCommand([], "inst-1")).toBeNull();
		expect(() =>
			ensureLinkNetworksCommand([{ name: "bridge", linkId: id }], "inst-1"),
		).toThrow();
	});

	it("prunes only this instance's unused link networks", () => {
		const command = pruneLinkNetworksCommand(
			["nitrobase-link-89abcdef00004000800000000000c0de"],
			"inst-1",
		);
		expect(command).toContain(
			"--filter 'label=nitrobase.instance=inst-1' --filter 'label=nitrobase.link'",
		);
		expect(command).toContain(
			"grep -vxF -e 'nitrobase-link-89abcdef00004000800000000000c0de');",
		);
		expect(command.match(/docker network ls/g)).toHaveLength(1);
		expect(pruneLinkNetworksCommand([], "inst-1")).toContain(
			"--format '{{.Name}}'); do docker network rm",
		);
	});

	it("accepts link network names, nothing else", () => {
		const hex = "89abcdef00004000800000000000c0de";
		const name = `nitrobase-link-${hex}`;
		expect(removeLinkNetworkCommand(name)).toContain(`'${name}'`);
		expect(() => removeLinkNetworkCommand(`other-link-${hex}`)).toThrow();
		expect(() => removeLinkNetworkCommand("nitrobase-link-x")).toThrow();
	});
});
