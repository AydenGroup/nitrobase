import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const { isPermission } = await import("#/config/permissions.ts");

/**
 * Authorization coverage: every server function, API route, SSE stream and
 * WebSocket endpoint must name a permission from the registry (or be on the
 * short, reasoned allowlist below). A new endpoint without a gate fails
 * here instead of shipping unchecked.
 */

const root = path.resolve(__dirname, "../../..");

function walk(dir: string, match: (file: string) => boolean): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) return walk(full, match);
		return match(full) ? [full] : [];
	});
}

const rel = (file: string) => path.relative(root, file);

/** Server functions that are not team-scoped, with the reason. */
const ungatedFunctions: Record<string, string> = {
	// Anonymous by nature (sign-in, sign-up, setup state, invite preview).
	loginFn: "public: sign-in",
	verifyLoginTwoFactorFn: "public: second sign-in step",
	registerFn: "public: bootstrap or invite-only sign-up",
	logoutFn: "public: ends the caller's own session",
	getCurrentUserFn: "public: the caller's own user or null",
	isInitialSetupCompleteFn: "public: whether any account exists",
	getSetupInfoFn:
		"public: whether any account exists and a setup token is required",
	previewInviteFn: "public: the invite token is the secret",
	// Account-level (authMiddleware): the caller's own account, any team.
	updateProfileFn: "account",
	getTwoFactorStatusFn: "account",
	startTwoFactorEnrollmentFn: "account",
	confirmTwoFactorEnrollmentFn: "account",
	disableTwoFactorFn: "account",
	regenerateRecoveryCodesFn: "account",
	listSessionsFn: "account",
	revokeSessionFn: "account",
	revokeOtherSessionsFn: "account",
	getTeamContextFn: "account: the caller's teams and permissions",
	switchTeamFn: "account: membership checked",
	createTeamFn: "account: TEAM_CREATION decides",
	acceptInviteFn: "account: the invite token is the secret",
	getInstanceStateFn: "account: whether background work is paused",
};

/** Source without // and /* *\/ comments (good enough for our own files). */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Every `createServerFn(` must be an `export const X = createServerFn` block
 * whose own `.middleware([...])` holds `requirePermission("<registered>")`,
 * or be allowlisted (account fns must then use authMiddleware).
 */
function scanServerFunctions(raw: string): {
	count: number;
	problems: string[];
} {
	const source = stripComments(raw);
	const problems: string[] = [];
	const total = source.match(/createServerFn\(/g)?.length ?? 0;
	const blocks = source.split(/export const (\w+)\s*=\s*createServerFn(?=\()/);
	const declared = (blocks.length - 1) / 2;
	if (declared !== total) {
		problems.push(
			`${total - declared} createServerFn call(s) not declared as \`export const X = createServerFn(...)\``,
		);
	}
	for (let i = 1; i < blocks.length; i += 2) {
		const name = blocks[i];
		const body = blocks[i + 1].split(/\nexport /)[0];
		const middleware = [...body.matchAll(/\.middleware\(\[([^\]]*)\]\)/g)]
			.map((match) => match[1])
			.join(" ");
		const gates = [...middleware.matchAll(/requirePermission\("([^"]+)"\)/g)];
		if (gates.length > 0) {
			for (const [, permission] of gates) {
				if (!isPermission(permission)) {
					problems.push(`${name}: unknown "${permission}"`);
				}
			}
			continue;
		}
		const reason = ungatedFunctions[name];
		if (!reason) problems.push(`${name}: no requirePermission gate`);
		else if (
			reason.startsWith("account") &&
			!/\bauthMiddleware\b/.test(middleware)
		) {
			problems.push(`${name}: account fn without authMiddleware`);
		}
	}
	return { count: declared, problems };
}

describe("authorization coverage", () => {
	const files = walk(path.join(root, "src"), (file) =>
		/\.(ts|tsx)$/.test(file),
	);

	it("declares server functions only in *.functions.ts", () => {
		const offenders = files.filter(
			(file) =>
				!file.endsWith(".functions.ts") &&
				!file.endsWith(".test.ts") &&
				/createServerFn\(/.test(readFileSync(file, "utf8")),
		);
		expect(offenders.map(rel)).toEqual([]);
	});

	it("gates every server function with a registered permission", () => {
		const problems: string[] = [];
		let count = 0;
		for (const file of files.filter((f) => f.endsWith(".functions.ts"))) {
			const result = scanServerFunctions(readFileSync(file, "utf8"));
			count += result.count;
			problems.push(
				...result.problems.map((problem) => `${rel(file)} ${problem}`),
			);
		}
		expect(problems).toEqual([]);
		expect(count).toBeGreaterThan(100);
	});

	it("the scanner itself rejects disguised or missing gates", () => {
		const fn = (middleware: string, extra = "") =>
			`${extra}export const thingFn = createServerFn({ method: "POST" })\n\t.middleware([${middleware}])\n\t.handler(async () => 1);\n`;
		expect(
			scanServerFunctions(fn('requirePermission("app.view")')).problems,
		).toEqual([]);
		// Gate only in a comment or outside .middleware([...]).
		expect(
			scanServerFunctions(
				fn("authMiddleware", '// requirePermission("app.view")\n'),
			).problems,
		).not.toEqual([]);
		expect(
			scanServerFunctions(
				`${fn("authMiddleware")}const x = requirePermission("app.view");\n`,
			).problems,
		).not.toEqual([]);
		// Declared in a way the block matcher doesn't see.
		expect(
			scanServerFunctions(
				'const hidden = createServerFn({ method: "GET" }).handler(async () => 1);\nexport { hidden };\n',
			).problems,
		).not.toEqual([]);
		expect(
			scanServerFunctions(fn('requirePermission("no.such")')).problems,
		).not.toEqual([]);
	});

	/** HTTP routes outside the permission model, with the reason. */
	const ungatedRoutes: Record<string, string> = {
		"src/routes/api/avatars/$style.$seed.ts":
			"account: generated identicons of any member",
		"src/routes/api/v1/$.ts":
			"API surface: every registry entry declares a permission (tested below)",
		"src/routes/api/health.ts":
			"public: liveness of the container health check (no data)",
		"src/routes/api/install[.]sh.ts":
			"public: the installer script shipped with this build (no data)",
		"src/routes/api/setup/restore.ts":
			"public: first-run restore, refused once any account exists (same window as the first sign-up)",
		"src/routes/api/hooks/git/$hookId.ts":
			"public: git push webhook, verified with the app's webhook secret (HMAC/token per provider), same 401 for unknown hooks and bad signatures, rate limited",
	};

	it("gates every API route, SSE stream and download", () => {
		const routes = walk(path.join(root, "src/routes/api"), (file) =>
			file.endsWith(".ts"),
		);
		const problems = routes.flatMap((file) => {
			const source = readFileSync(file, "utf8");
			if (ungatedRoutes[rel(file)]) return [];
			const gates = [...source.matchAll(/requirePermission\("([^"]+)"\)/g)];
			if (gates.length === 0) return [`${rel(file)}: no requirePermission`];
			return gates
				.filter(([, permission]) => !isPermission(permission))
				.map(([, permission]) => `${rel(file)}: unknown "${permission}"`);
		});
		expect(problems).toEqual([]);
		expect(routes.length).toBeGreaterThan(5);
	});

	it("gates every WebSocket upgrade", () => {
		const sockets = walk(path.join(root, "src/server/routes"), (file) =>
			file.endsWith(".ts"),
		);
		const problems = sockets.flatMap((file) => {
			const source = readFileSync(file, "utf8");
			const match = source.match(/permission: "([^"]+)"/);
			if (!/createTerminalHandler\(/.test(source)) {
				return [`${rel(file)}: not built on createTerminalHandler`];
			}
			return match && isPermission(match[1])
				? []
				: [`${rel(file)}: no valid permission`];
		});
		expect(problems).toEqual([]);
		expect(sockets.length).toBeGreaterThan(0);
	});

	it("declares a permission for every /api/v1 operation", () => {
		const source = readFileSync(
			path.join(root, "src/server/api/v1.ts"),
			"utf8",
		);
		const entries = source.split(/\n\troute\(\{/).slice(1);
		const problems = entries.flatMap((entry) => {
			const id = entry.match(/id: "(\w+)"/)?.[1] ?? "?";
			const permission = entry.match(/permission: "([^"]+)"/)?.[1];
			return permission && isPermission(permission)
				? []
				: [`${id}: missing or unknown permission`];
		});
		expect(problems).toEqual([]);
		expect(entries.length).toBeGreaterThanOrEqual(10);
	});
});
