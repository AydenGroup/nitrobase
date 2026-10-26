import { linguiTransformerBabelPreset } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";
import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so tests don't boot nitro / TanStack Start.
// The Lingui macro is compiled like in the app (only files importing it):
// modules declaring `msg` descriptors (error codes, registries) load as
// they do at runtime.
export default defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [babel({ presets: [linguiTransformerBabelPreset()] })],
	test: {
		environment: "node",
		include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
	},
});
