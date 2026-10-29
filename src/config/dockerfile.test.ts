import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The server spawns system tools that the Alpine image must install: a
 * development machine has them anyway, so only a real install would fail.
 */
const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

const packages = new Set(
	(/^RUN apk add --no-cache (.+)$/m.exec(read("Dockerfile"))?.[1] ?? "").split(
		/\s+/,
	),
);

describe("panel image", () => {
	it.each([
		["ssh-keygen", "src/server/services/ssh-keygen.ts", "openssh-keygen"],
		["nsenter", "src/server/services/local.ts", "util-linux"],
		["pg_dump", "src/config/server.ts", "postgresql16-client"],
		["psql", "src/config/server.ts", "postgresql16-client"],
	])("ships %s (used by %s) through %s", (tool, file, pkg) => {
		expect(read(file)).toContain(tool);
		expect(packages).toContain(pkg);
	});
});
