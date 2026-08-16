#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

/**
 * High-fan-out imports on the root route. Each rule records a boundary that
 * previously pulled hundreds of unrelated modules into `pnpm dev`.
 */
export const ROOT_LOADING_RULES = [
  {
    file: "app/layout.tsx",
    forbidden: ["@/app/e2e/plugin-ui-surfaces/plugin-surface-reference-harness"],
    reason: "E2E surface enumeration must stay behind a dynamic import.",
  },
  {
    file: "components/providers/tauri-provider.tsx",
    forbidden: ["@/hooks/chat"],
    reason: "Import the notification hook directly; the chat barrel reaches the full chat runtime.",
  },
  {
    file: "components/plugins/plugin-enable-failure-toaster.tsx",
    forbidden: ["@/lib/plugin/core/manager"],
    reason: "The toaster may depend on the lightweight event contract, not the plugin manager.",
  },
  {
    file: "stores/plugin-runtime/plugin-store.ts",
    forbidden: ["@/lib/plugin"],
    reason: "Import validation directly; the plugin barrel exports every runtime API namespace.",
  },
  {
    file: "stores/artifact/artifact-store.ts",
    forbidden: ["@/lib/plugin"],
    reason: "Import event hooks directly; the plugin barrel exports every runtime API namespace.",
  },
  {
    file: "stores/ui/ui-store.ts",
    forbidden: ["@/lib/plugin"],
    reason: "Import event hooks directly; the plugin barrel exports every runtime API namespace.",
  },
  {
    file: "components/desktop/command-palette.tsx",
    forbidden: ["@/lib/plugin"],
    reason: "Import event hooks directly; the plugin barrel exports every runtime API namespace.",
  },
  {
    file: "hooks/shortcuts/use-app-shortcut-dispatcher.ts",
    forbidden: ["@/lib/plugin"],
    reason: "Import event hooks directly; the plugin barrel exports every runtime API namespace.",
  },
  {
    file: "lib/scheduler/task-scheduler.ts",
    forbidden: ["@/lib/plugin"],
    reason:
      "Import lifecycle hooks directly; the plugin barrel exports every runtime API namespace.",
  },
  {
    file: "lib/tauri/canvas.ts",
    forbidden: ["@/lib/plugin"],
    reason: "Import event hooks directly; the plugin barrel exports every runtime API namespace.",
  },
  {
    file: "lib/terminal/spawn-orchestrator.ts",
    forbidden: ["@/lib/plugin"],
    reason: "Import event hooks directly; the plugin barrel exports every runtime API namespace.",
  },
  {
    file: "components/plugins/plugin-extension-slot.tsx",
    forbidden: ["@/lib/plugin/api"],
    reason:
      "Import the extension registry directly; the API barrel exports every plugin namespace.",
  },
  {
    file: "components/plugins/plugin-extension-slot-with-overflow.tsx",
    forbidden: ["@/lib/plugin/api"],
    reason:
      "Import the extension registry directly; the API barrel exports every plugin namespace.",
  },
  {
    file: "lib/claude/build-options.ts",
    forbidden: ["@/lib/agent"],
    reason: "Deep-import the mode helper; the agent barrel exports the complete icon registry.",
  },
  {
    file: "packages/provider-routing/src/default-mappings.ts",
    forbidden: ["@cognia/provider-core"],
    reason: "Use provider-core subpaths; its root barrel exports every AI SDK client.",
  },
  {
    file: "packages/provider-embedding/src/embedding.ts",
    forbidden: [
      "@ai-sdk/openai",
      "@ai-sdk/google",
      "@ai-sdk/cohere",
      "@ai-sdk/mistral",
      "@ai-sdk/amazon-bedrock",
    ],
    reason: "Provider SDKs are request-scoped and must be loaded with import() on demand.",
  },
]

export function extractStaticImports(source, fileName = "source.ts") {
  const scriptKind = fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind)
  const imports = []
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    if (statement.importClause?.isTypeOnly) continue
    imports.push(statement.moduleSpecifier.text)
  }
  return imports
}

export function findRootLoadingBoundaryViolations(
  repoRoot = REPO_ROOT,
  rules = ROOT_LOADING_RULES
) {
  const violations = []
  for (const rule of rules) {
    const imports = extractStaticImports(readFileSync(join(repoRoot, rule.file), "utf8"), rule.file)
    for (const specifier of imports) {
      if (!rule.forbidden.includes(specifier)) continue
      violations.push({ ...rule, specifier })
    }
  }
  return violations
}

export function main() {
  const violations = findRootLoadingBoundaryViolations()
  if (violations.length === 0) {
    console.log(
      `[root-loading] OK: ${ROOT_LOADING_RULES.length} high-fan-out boundaries preserved.`
    )
    return 0
  }
  console.error(`[root-loading] ${violations.length} boundary violation(s):`)
  for (const violation of violations) {
    console.error(`  ${violation.file}: static import ${JSON.stringify(violation.specifier)}`)
    console.error(`    ${violation.reason}`)
  }
  return 1
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main())
