import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // React Compiler rules from react-hooks v7 — too strict for existing code
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "react-hooks/unsupported-syntax": "off",
    },
  },
  {
    ignores: [
      "dist/",
      "node_modules/",
      "drizzle/",
      "**/*.cjs",
      "python_service/",
      ".claude/",
      "deploy/",
      "patches/",
    ],
  },
);
