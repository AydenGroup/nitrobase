import { linguiTransformerBabelPreset } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";
import { defineConfig } from "vitest/config";

/**
 * Cloud sync smoke tests against a fake cloud (throwaway Docker containers
 * named <prefix>-*, created and removed by the tests): the import
 * (import.smoke.ts) and the export into an empty project (export.smoke.ts).
 * Needs Docker on this machine and network access to pull the images;
 * never touches a real cloud account. Run from the repository root:
 *
 *   bunx vitest run --config scripts/smoke/cloud-sync/vitest.config.ts
 *
 * SMOKE_PREFIX (default cs-agent) names the containers, network and
 * folders; SMOKE_API_PORT (default 3102) is the mock Management API's port.
 */
const prefix = process.env.SMOKE_PREFIX ?? "cs-agent";
const port = process.env.SMOKE_API_PORT ?? "3102";

export default defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [babel({ presets: [linguiTransformerBabelPreset()] })],
	test: {
		environment: "node",
		include: ["scripts/smoke/cloud-sync/*.smoke.ts"],
		// One fake cloud at a time: the files share the network and the port.
		fileParallelism: false,
		testTimeout: 15 * 60_000,
		hookTimeout: 10 * 60_000,
		env: {
			SMOKE_PREFIX: prefix,
			SMOKE_API_PORT: port,
			// Lowercase path: NITROBASE_ROOT must match its config pattern.
			NITROBASE_ROOT: `/private/tmp/${prefix}-smoke/root`,
			NITROBASE_NETWORK: `${prefix}-net`,
			CLOUD_SYNC_DUMP_NETWORK: `${prefix}-net`,
			CLOUD_SYNC_ALLOW_PRIVATE: "true",
			CLOUD_SYNC_SUPABASE_API_URL: `http://127.0.0.1:${port}`,
			CLOUD_SYNC_API_RETRIES: "1",
			ENCRYPTION_KEY: "smoke-test-encryption-key-0123456789abcdef",
			SESSION_SECRET: "smoke-test-session-secret-0123456789abcdef",
		},
	},
});
