import { readFileSync } from "node:fs";
import { lingui, linguiTransformerBabelPreset } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const packageJson = JSON.parse(readFileSync("./package.json", "utf-8"));

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	optimizeDeps: {
		exclude: ["ssh2", "cpu-features", "dockerode", "pg"],
	},
	server: {
		// Compile every route (and what it imports) in the background at
		// startup, so opening a page for the first time doesn't wait on it.
		warmup: {
			clientFiles: ["./src/routes/**/*.tsx"],
			ssrFiles: ["./src/server.ts", "./src/routes/**/*.tsx"],
		},
	},
	ssr: {
		external: ["ssh2", "cpu-features", "dockerode", "pg"],
		noExternal: ["@xterm/xterm", "@xterm/addon-fit"],
	},
	plugins: [
		devtools(),
		nitro({
			preset: "node",
			scanDirs: ["./src/server/routes"],
			plugins: ["./src/server/plugins/startup.ts"],
			features: { websocket: true },
			rollupConfig: { external: [/^@sentry\//, "ssh2", "cpu-features"] },
		}),
		tanstackStart(),
		viteReact(),
		// Only filtered presets, so babel skips files neither one matches
		// (a top-level `plugins` entry would run it on the whole graph).
		babel({
			exclude: /\/node_modules\//,
			presets: [linguiTransformerBabelPreset(), reactCompilerPreset()],
		}),
		lingui(),
	],
	define: {
		"import.meta.env.PACKAGE_VERSION": JSON.stringify(packageJson.version),
	},
});

export default config;
