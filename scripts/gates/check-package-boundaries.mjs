#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import ts from "typescript"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

// These libraries must be usable without the application source tree. The
// plugin SDK is intentionally a host facade and is governed by its own gate.
// Unlike root-loading rules, this boundary includes types and lazy imports.
export const HOST_INDEPENDENT_PACKAGES = ["error-parsers", "provider-types", "vector", "eval-core"]

// The report is a data-only view. Dataset configuration belongs to eval's
// application layer; these components must not access persistence or foreign
// stores. The run dialog may still own state in eval's UI store.
export const EVAL_UI_BOUNDARIES = [
  { file: "components/eval/eval-report-panel.tsx", forbidden: ["lib", "stores", "hooks", "types"] },
  { file: "components/eval/eval-dashboard.tsx", forbidden: ["lib/db", "stores"] },
  { file: "components/eval/dataset-detail.tsx", forbidden: ["lib/db", "stores"] },
  {
    file: "components/eval/blind-review-panel.tsx",
    forbidden: ["lib", "stores"],
    allowed: ["lib/ai/eval/review-service.ts", "lib/utils.ts"],
  },
  {
    file: "components/eval/eval-lab-workspace.tsx",
    forbidden: [
      "lib/ai/eval/browser-execution.ts",
      "lib/ai/eval/orchestrator.ts",
      "lib/ai/eval/artifact-crypto.ts",
      "lib/ai/eval/project-service.ts",
      "lib/ai/eval/recovery.ts",
      "lib/ai/eval/report-view.ts",
      "lib/ai/eval/execution-runtime.ts",
    ],
  },
  {
    file: "components/eval/run-config-dialog.tsx",
    forbidden: ["lib/db", "stores"],
    allowed: ["stores/eval"],
  },
]

function isWithin(parent, file) {
  const path = relative(parent, file)
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return ["node_modules", "dist", "__fixtures__", "__mocks__"].includes(entry.name)
        ? []
        : sourceFiles(path)
    }
    return /\.[cm]?tsx?$/.test(entry.name) && !/\.(?:test|spec|stories)\./.test(entry.name)
      ? [path]
      : []
  })
}

export function extractModuleReferences(source, fileName = "source.ts") {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const references = []
  function visit(node) {
    let specifier
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      specifier = node.moduleReference.expression
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      specifier = node.arguments[0]
    }
    if (specifier && ts.isStringLiteralLike(specifier)) {
      references.push({
        specifier: specifier.text,
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return references
}

function moduleResolver(repoRoot) {
  const configPath = join(repoRoot, "tsconfig.json")
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"))
  // Only resolution options are needed; don't enumerate the entire app's TS
  // program while checking the selected boundaries.
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    { ...ts.sys, readDirectory: () => [] },
    repoRoot
  )
  const cache = ts.createModuleResolutionCache(repoRoot, (path) => path, parsed.options)
  return (file, specifier) =>
    ts.resolveModuleName(specifier, file, parsed.options, ts.sys, cache).resolvedModule
      ?.resolvedFileName ??
    (specifier.startsWith("@/")
      ? resolve(repoRoot, specifier.slice(2))
      : specifier.startsWith(".")
        ? resolve(dirname(file), specifier)
        : undefined)
}

export function findPackageBoundaryViolations(
  repoRoot = REPO_ROOT,
  packages = HOST_INDEPENDENT_PACKAGES
) {
  const resolveModule = moduleResolver(repoRoot)
  const packageRoot = join(repoRoot, "packages")
  const violations = []
  for (const name of packages) {
    for (const file of sourceFiles(join(packageRoot, name, "src"))) {
      for (const reference of extractModuleReferences(readFileSync(file, "utf8"), file)) {
        // Keep detecting direct host paths even when their target was deleted
        // or renamed; unresolved external packages belong to the typecheck.
        const target = resolveModule(file, reference.specifier)
        if (
          target &&
          isWithin(repoRoot, target) &&
          !isWithin(packageRoot, target) &&
          !target.split(sep).includes("node_modules")
        ) {
          violations.push({
            file: relative(repoRoot, file).split(sep).join("/"),
            ...reference,
            target: relative(repoRoot, target).split(sep).join("/"),
          })
        }
      }
    }
  }
  return violations
}

export function findEvalUiBoundaryViolations(repoRoot = REPO_ROOT, rules = EVAL_UI_BOUNDARIES) {
  const resolveModule = moduleResolver(repoRoot)
  return rules.flatMap(({ file, forbidden, allowed = [] }) => {
    const path = join(repoRoot, file)
    return extractModuleReferences(readFileSync(path, "utf8"), path).flatMap((reference) => {
      const target = resolveModule(path, reference.specifier)
      return target &&
        forbidden.some((directory) => isWithin(join(repoRoot, directory), target)) &&
        !allowed.some((directory) => isWithin(join(repoRoot, directory), target))
        ? [{ file, ...reference, target: relative(repoRoot, target).split(sep).join("/") }]
        : []
    })
  })
}

export function main() {
  const violations = [...findPackageBoundaryViolations(), ...findEvalUiBoundaryViolations()]
  if (violations.length) {
    console.error(`[package-boundaries] ${violations.length} host-private reference(s):`)
    for (const { file, line, specifier, target } of violations) {
      console.error(`  ${file}:${line}: ${specifier} -> ${target}`)
    }
    return 1
  }
  console.log(
    `[package-boundaries] OK: ${HOST_INDEPENDENT_PACKAGES.length} packages and ${EVAL_UI_BOUNDARIES.length} eval UI boundaries preserved.`
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
