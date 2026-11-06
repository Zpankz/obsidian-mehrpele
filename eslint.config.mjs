// Lint with the rules the Obsidian community directory's review uses.
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  globalIgnores(["node_modules", "main.js", "esbuild.config.mjs", "eslint.config.mjs", "tests", "docs", "scripts"]),
  ...obsidianmd.configs.recommended,
  {
    // This provider also runs in the standalone CLI; timers only abort requests,
    // never manipulate a document, so they must not depend on a browser window.
    files: ["lib/pele-render/repair/providers.ts"],
    rules: { "obsidianmd/prefer-window-timers": "off" },
  },
  {
    files: ["lib/pele-render/node-size/index.ts"],
    rules: {
      "@typescript-eslint/no-deprecated": ["warn", {
        allow: [{ from: "file", name: "SIZE_DIRECTIVE_RE", path: "lib/pele-render/node-size/directive.ts" }],
      }],
    },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.*"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
