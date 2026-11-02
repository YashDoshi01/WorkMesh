import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "coverage/**", "**/.publish/**"],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    // The dashboard: React's rules of hooks and exhaustive dependency checking.
    files: ["apps/dashboard/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    // Test helpers read untyped JSON responses.
    files: ["tests/**/*.ts", "bench/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // Plain Node scripts (the npm package build).
    files: ["**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
);
