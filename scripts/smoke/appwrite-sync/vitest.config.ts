import { linguiTransformerBabelPreset } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";
import { defineConfig } from "vitest/config";

/**
 * Appwrite cloud sync smoke tests: throwaway Appwrite apps rendered from
 * templates/appwrite (containers, volumes and network named <prefix>-*).
 * import.smoke.ts: one app seeded as the "cloud", another imported into.
 * export.smoke.ts: a seeded app exported into a fresh one playing Appwrite
 * Cloud. Needs Docker with ~8 GB of memory and network access to pull the
 * images; never touches a real cloud account. Run from the repository root:
 *
 *   bunx vitest run --config scripts/smoke/appwrite-sync/vitest.config.ts
 *
 * SMOKE_PREFIX (default aw-agent) names what the smokes create.
 * AW_SMOKE_KEEP=1 keeps the apps running afterwards (re-runs reuse them).
 */
const prefix = process.env.SMOKE_PREFIX ?? "aw-agent";

export default defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [babel({ presets: [linguiTransformerBabelPreset()] })],
	test: {
		environment: "node",
		include: ["scripts/smoke/appwrite-sync/*.smoke.ts"],
		// Two Appwrite apps per file are enough for one machine.
		fileParallelism: false,
		testTimeout: 40 * 60_000,
		hookTimeout: 40 * 60_000,
		env: {
			SMOKE_PREFIX: prefix,
			NITROBASE_ROOT: `/private/tmp/${prefix}-smoke/root`,
			NITROBASE_NETWORK: `${prefix}-net`,
			CLOUD_SYNC_ALLOW_PRIVATE: "true",
			// The app playing Appwrite Cloud reads the exported app on the
			// private smoke network, not at a public HTTPS address.
			CLOUD_SYNC_EXPORT_SKIP_REACHABILITY: "true",
			CLOUD_SYNC_API_RETRIES: "1",
			CLOUD_SYNC_APPWRITE_POLL_MS: "2000",
			ENCRYPTION_KEY: "smoke-test-encryption-key-0123456789abcdef",
			SESSION_SECRET: "smoke-test-session-secret-0123456789abcdef",
		},
	},
});
