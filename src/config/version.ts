/**
 * This build's version: package.json `version`, injected at build time
 * (`define` in vite.config.ts). Development and tests fall back to a
 * placeholder that never counts as newer than a release.
 */
export const APP_VERSION: string =
	import.meta.env.PACKAGE_VERSION || "0.0.0-dev";
