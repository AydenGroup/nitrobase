import { extractor as babelExtractor } from "@lingui/cli/api";
import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-json";
import { templateExtractor } from "./scripts/lingui/template-extractor.ts";
import { localeCodes, sourceLocale } from "./src/libs/locale-manifest.ts";

// Locales come from src/locales/locales.json (the single manifest, shared
// with src/libs/i18n.ts). Adding a language = a manifest entry, then
// `bun run i18n:extract` and translate src/locales/<code>.json.
export default defineConfig({
  sourceLocale,
  locales: localeCodes,
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}",
      // templates/: template.toml texts (English) via templateExtractor.
      include: ["<rootDir>/src/**", "<rootDir>/templates/**"],
      exclude: ["**/node_modules/**"],
    },
  ],
  extractors: [babelExtractor, templateExtractor],
  format: formatter({ style: "minimal" }),
});
