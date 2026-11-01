import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "coverage/**"],
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
    files: ["tests/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
