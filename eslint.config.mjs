// Lint with the rules the Obsidian community directory's review uses.
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  globalIgnores(["node_modules", "main.js", "esbuild.config.mjs", "eslint.config.mjs", "tests", "docs", "scripts"]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.*"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
