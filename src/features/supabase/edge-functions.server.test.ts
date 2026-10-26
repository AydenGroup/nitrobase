import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	const state = {
		listing: "",
		readTar: "",
		commands: [] as string[],
		config: {
			functions_service: "functions",
			functions_dir: "/home/deno/functions",
			functions_reserved: ["main"],
			functions_entrypoints: ["index.ts", "index.js"],
		},
	};
	const executor = {
		exec: async (command: string) => {
			state.commands.push(command);
			if (command.includes("for d in ./*/")) {
				return { exitCode: 0, stdout: state.listing, stderr: "" };
			}
			if (command.includes("| base64")) {
				return { exitCode: 0, stdout: state.readTar, stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		},
	};
	return { state, executor, audit: vi.fn() };
});

vi.mock("#/config/server.ts", () => ({
	getConfig: () => ({
		SUPABASE_FUNCTION_MAX_FILES: 50,
		SUPABASE_FUNCTION_MAX_BYTES: 1024 * 1024,
	}),
}));
vi.mock("#/features/apps/apps.server.ts", () => ({ appLocation: () => ({}) }));
vi.mock("#/features/deployments/deployments.server.ts", () => ({
	withAppServerLock: (_app: unknown, fn: () => unknown) => fn(),
}));
vi.mock("#/server/services/audit.ts", () => ({ audit: h.audit }));
vi.mock("#/server/services/apps/commands.ts", () => ({
	composeServiceCommand: (_loc: unknown, action: string, service: string) =>
		`compose ${action} ${service}`,
}));
vi.mock("./supabase.server", () => ({
	gatewayRequest: vi.fn(),
	requireDeployed: vi.fn(),
	supabaseContext: async () => ({
		app: { id: "app-1" },
		config: h.state.config,
		container: (service: string) => `supabase-0123abcd-${service}`,
	}),
	withExecutor: async (_ctx: unknown, fn: (executor: unknown) => unknown) =>
		fn(h.executor),
}));

const { buildTar } = await import(
	"#/server/services/supabase/edge-functions.ts"
);
const {
	deleteSharedFolder,
	getSharedFolder,
	listEdgeFunctions,
	listSharedFolders,
	saveSharedFolder,
} = await import("./edge-functions.server");

const actor = {} as never;
const LIST =
	"watch\t1700000000\t1\nhello\t1700000000\t1\n_shared\t1700000000\t0\nlib\t1700000000\t0\nmain\t1700000000\t1\n";
const files = [{ path: "util.ts", content: "export {};" }];
const writes = () =>
	h.state.commands.filter(
		(c) =>
			c.includes("docker cp -") ||
			c.includes("rm -rf") ||
			c.startsWith("compose"),
	);

beforeEach(() => {
	h.state.listing = LIST;
	h.state.readTar = "";
	h.state.commands = [];
	h.state.config.functions_entrypoints = ["index.ts", "index.js"];
	h.audit.mockClear();
});

describe("listing", () => {
	it("lists only functions in the functions list", async () => {
		const list = await listEdgeFunctions(actor, "app-1");
		expect(list.map((f) => f.name)).toEqual(["hello", "watch"]);
	});

	it("lists shared folders (underscore or no entrypoint)", async () => {
		const list = await listSharedFolders(actor, "app-1");
		expect(list.map((f) => f.name).sort()).toEqual(["_shared", "lib"]);
	});

	it("keeps a folder without entrypoint a function when the template names none", async () => {
		h.state.config.functions_entrypoints = [];
		const fns = await listEdgeFunctions(actor, "app-1");
		expect(fns.map((f) => f.name)).toContain("lib");
		const shared = await listSharedFolders(actor, "app-1");
		expect(shared.map((f) => f.name)).toEqual(["_shared"]);
	});
});

describe("saveSharedFolder", () => {
	it("writes an existing shared folder, restarts functions and audits", async () => {
		await saveSharedFolder(actor, { appId: "app-1", name: "_shared", files });
		expect(h.state.commands.some((c) => c.includes("docker cp -"))).toBe(true);
		expect(h.state.commands).toContain("compose restart functions");
		expect(h.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "supabase.shared.deploy",
				meta: { name: "_shared", files: ["util.ts"] },
			}),
		);
	});

	it("edits an existing plain-name folder without an entrypoint", async () => {
		await saveSharedFolder(actor, { appId: "app-1", name: "lib", files });
		expect(writes().length).toBeGreaterThan(0);
	});

	it("refuses a real function before any write", async () => {
		await expect(
			saveSharedFolder(actor, { appId: "app-1", name: "watch", files }),
		).rejects.toMatchObject({ code: "FUNCTION_NOT_SHARED" });
		expect(writes()).toEqual([]);
	});

	it("refuses a plain folder that has an entrypoint", async () => {
		h.state.listing = "lib\t1700000000\t1\n";
		await expect(
			saveSharedFolder(actor, { appId: "app-1", name: "lib", files }),
		).rejects.toMatchObject({ code: "FUNCTION_NOT_SHARED" });
		expect(writes()).toEqual([]);
	});

	it("refuses a reserved name without running any command", async () => {
		await expect(
			saveSharedFolder(actor, { appId: "app-1", name: "main", files }),
		).rejects.toMatchObject({ code: "FUNCTION_NAME_RESERVED" });
		expect(h.state.commands).toEqual([]);
	});

	it("reports a missing folder", async () => {
		await expect(
			saveSharedFolder(actor, { appId: "app-1", name: "_nope", files }),
		).rejects.toMatchObject({ code: "FUNCTION_SHARED_NOT_FOUND" });
		expect(writes()).toEqual([]);
	});

	it("refuses unsafe file paths before any command", async () => {
		await expect(
			saveSharedFolder(actor, {
				appId: "app-1",
				name: "_shared",
				files: [{ path: "../evil.ts", content: "x" }],
			}),
		).rejects.toMatchObject({ code: "FUNCTION_FILE_PATH_INVALID" });
		expect(h.state.commands).toEqual([]);
	});
});

describe("create", () => {
	it("creates a new underscore folder and audits create", async () => {
		await saveSharedFolder(
			actor,
			{ appId: "app-1", name: "_utils", files },
			{ create: true },
		);
		expect(h.state.commands.some((c) => c.includes("docker cp -"))).toBe(true);
		expect(h.audit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "supabase.shared.create" }),
		);
	});

	it("requires the underscore prefix for new folders", async () => {
		await expect(
			saveSharedFolder(
				actor,
				{ appId: "app-1", name: "lib2", files },
				{ create: true },
			),
		).rejects.toMatchObject({ code: "SHARED_NAME_INVALID" });
		expect(h.state.commands).toEqual([]);
	});

	it("refuses a name that already exists", async () => {
		await expect(
			saveSharedFolder(
				actor,
				{ appId: "app-1", name: "_shared", files },
				{ create: true },
			),
		).rejects.toMatchObject({ code: "FUNCTION_EXISTS" });
		expect(writes()).toEqual([]);
	});
});

describe("deleteSharedFolder", () => {
	it("removes only the shared folder and audits", async () => {
		await deleteSharedFolder(actor, "app-1", "_shared");
		const removals = h.state.commands.filter((c) => c.includes("rm -rf"));
		expect(removals).toHaveLength(1);
		expect(removals[0]).toContain(
			"docker exec 'supabase-0123abcd-functions' rm -rf -- '/home/deno/functions/_shared'",
		);
		expect(h.audit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "supabase.shared.delete" }),
		);
	});

	it("refuses a function through the shared path", async () => {
		await expect(
			deleteSharedFolder(actor, "app-1", "hello"),
		).rejects.toMatchObject({ code: "FUNCTION_NOT_SHARED" });
		expect(writes()).toEqual([]);
	});

	it("refuses main", async () => {
		await expect(
			deleteSharedFolder(actor, "app-1", "main"),
		).rejects.toMatchObject({ code: "FUNCTION_NAME_RESERVED" });
		expect(h.state.commands).toEqual([]);
	});
});

describe("getSharedFolder", () => {
	it("returns the files of a shared folder, nested paths included", async () => {
		h.state.readTar = buildTar(".", [
			{ path: "core/analysis.js", content: "export const a = 1;" },
			{ path: "util.ts", content: "export {};" },
		]).toString("base64");
		const source = await getSharedFolder(actor, "app-1", "_shared");
		expect(source.files.map((f) => f.path)).toEqual([
			"core/analysis.js",
			"util.ts",
		]);
		expect(source.skipped).toEqual([]);
	});

	it("refuses a function", async () => {
		await expect(
			getSharedFolder(actor, "app-1", "watch"),
		).rejects.toMatchObject({ code: "FUNCTION_NOT_SHARED" });
	});
});
