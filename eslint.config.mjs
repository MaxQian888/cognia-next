import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"
import prettier from "eslint-config-prettier"

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "src-tauri/target/**",
    "next-env.d.ts",
    "docs/.next/**",
    "docs/.source/**",
    "docs/next-env.d.ts",
    ".agents/**",
    ".claude/**",
    "sidecar/**",
    "node_modules/**",
    // Bundled Monaco assets copied from node_modules by
    // scripts/copy-monaco-assets.mjs — minified vendor JS, never authored here.
    "public/monaco/**",
  ]),
  // Allow underscore-prefixed unused variables (standard convention for intentional-unused).
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  // Vendored components (ai-elements, shadcn/ui) — relaxed rules per CLAUDE.md
  {
    files: ["components/ai-elements/**/*.{ts,tsx}", "components/ui/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
      "react-hooks/static-components": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/purity": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  // Jest CommonJS mock shims — runtime is Node CJS, require() is the correct call.
  {
    files: ["__mocks__/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Canvas-store re-export test relies on Jest's `require()` to compare
  // module identity — that's the right idiom for this exact assertion.
  {
    files: ["stores/canvas/index.test.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
])

export default eslintConfig
