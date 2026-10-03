#!/usr/bin/env node
/**
 * Gate: how much of the VS Code extension API the shim provides, measured
 * against the API level it claims.
 *
 * The extension host advertises `vscode.version` = `SHIM_VSCODE_API_VERSION`
 * and `vscode-languageclient` takes it at its word. This gate reads that
 * level's declarations (`@types/vscode`, pinned to the same version in
 * `sidecar/vscode-ext-host/package.json`) and checks every runtime value they
 * declare (each namespace member, class, enum and constant) against the shim
 * an extension actually receives:
 *
 *   implemented  mounted on the shim;
 *   unsupported  mounted, but declared unsupported with a reason in
 *                `src/vscode-shim/unsupported.ts` (whole namespace or member);
 *   missing      not mounted at all: an extension touching it gets `undefined`.
 *
 * The result is written to `lib/plugin/vscode-shim/vscode-api-coverage.generated.json`,
 * which the install-time compatibility hint reads (`engine-compat.ts`), so an
 * extension using an unsupported or missing API is flagged before it is
 * installed. `--check` fails when the shim and the committed report disagree,
 * so neither can change without the other; it also fails when an unsupported
 * entry names API that does not exist or that the shim does not mount.
 *
 * Interfaces and type aliases are compile-time only and are not counted.
 *
 * Usage:
 *   pnpm vscode-api-coverage:generate   # write the report
 *   pnpm audit:vscode-api-coverage      # verify it
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const HOST_ROOT = join(REPO_ROOT, "sidecar", "vscode-ext-host")
const TYPES_PATH = join(HOST_ROOT, "node_modules", "@types", "vscode", "index.d.ts")
const TYPES_PACKAGE = join(HOST_ROOT, "node_modules", "@types", "vscode", "package.json")
export const REPORT_PATH = join(
  REPO_ROOT,
  "lib",
  "plugin",
  "vscode-shim",
  "vscode-api-coverage.generated.json"
)

/**
 * The runtime values `vscode.d.ts` declares: top-level classes, enums,
 * constants and namespaces, and each namespace's functions, constants and
 * nested namespaces (as `namespace.member`).
 */
export function declaredApi(source) {
  const file = ts.createSourceFile("vscode.d.ts", source, ts.ScriptTarget.Latest, true)
  const topLevel = new Set()
  const namespaces = new Map()
  // Everything inside the ambient `declare module "vscode"` is exported,
  // with or without the keyword (1.91 declares `namespace comments` bare).
  const valuesOf = (statements, into) => {
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) into.add(statement.name.text)
      else if (ts.isClassDeclaration(statement) && statement.name) into.add(statement.name.text)
      else if (ts.isEnumDeclaration(statement)) into.add(statement.name.text)
      else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) into.add(declaration.name.text)
        }
      } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
        into.add(statement.name.text)
      }
    }
  }
  file.forEachChild((node) => {
    if (!ts.isModuleDeclaration(node) || !ts.isStringLiteral(node.name)) return
    if (node.name.text !== "vscode" || !node.body || !ts.isModuleBlock(node.body)) return
    valuesOf(node.body.statements, topLevel)
    for (const statement of node.body.statements) {
      if (
        ts.isModuleDeclaration(statement) &&
        ts.isIdentifier(statement.name) &&
        statement.body &&
        ts.isModuleBlock(statement.body)
      ) {
        const members = new Set()
        valuesOf(statement.body.statements, members)
        namespaces.set(statement.name.text, members)
      }
    }
  })
  return { topLevel, namespaces }
}

/** Everything callable and nothing real: what the shim's factories are built with. */
export function inertDependencies() {
  const make = (fixed = {}) =>
    new Proxy(function inert() {}, {
      get: (_target, property) => {
        if (Object.hasOwn(fixed, property)) return fixed[property]
        if (property === "then") return undefined
        if (property === Symbol.toPrimitive) return () => ""
        if (property === Symbol.iterator) return function* () {}
        return make()
      },
      apply: () => make(),
      construct: () => make(),
    })
  return make({ extensionId: "cognia.api-coverage" })
}

/** Every declared value as `implemented`, `unsupported` (with its reason) or `missing`. */
export function classify(declared, shim, unsupported) {
  const errors = []
  const report = { implemented: [], unsupported: {}, missing: [], extra: [] }
  const reasonFor = (path) => {
    if (unsupported[path]) return unsupported[path]
    const namespace = path.split(".")[0]
    return path.includes(".") ? unsupported[namespace] : undefined
  }
  const record = (path, mounted) => {
    const reason = reasonFor(path)
    if (reason && mounted) report.unsupported[path] = reason
    else if (mounted) report.implemented.push(path)
    else report.missing.push(path)
  }
  const declaredPaths = new Set(declared.topLevel)
  for (const name of declared.topLevel) {
    if (declared.namespaces.has(name)) continue
    record(name, name in shim)
  }
  for (const [namespace, members] of declared.namespaces) {
    const mounted = shim[namespace]
    if (!mounted) {
      for (const member of members) report.missing.push(`${namespace}.${member}`)
      continue
    }
    // A namespace declared unsupported as a whole is reported as such too.
    if (unsupported[namespace]) report.unsupported[namespace] = unsupported[namespace]
    for (const member of members) {
      declaredPaths.add(`${namespace}.${member}`)
      record(`${namespace}.${member}`, member in mounted)
    }
    for (const member of Object.keys(mounted)) {
      if (!members.has(member)) report.extra.push(`${namespace}.${member}`)
    }
  }
  for (const name of Object.keys(shim)) {
    if (!declared.topLevel.has(name)) report.extra.push(name)
  }
  for (const path of Object.keys(unsupported)) {
    if (!declaredPaths.has(path)) {
      errors.push(`unsupported.ts names "${path}", which vscode.d.ts does not declare`)
      continue
    }
    const [namespace, member] = path.split(".")
    const mounted = member ? shim[namespace] && member in shim[namespace] : namespace in shim
    if (!mounted) {
      errors.push(
        `unsupported.ts names "${path}", which the shim does not mount: an extension would get undefined, not the reason`
      )
    }
  }
  report.implemented.sort()
  report.missing.sort()
  report.extra.sort()
  report.unsupported = Object.fromEntries(Object.entries(report.unsupported).sort())
  return { report, errors }
}

/** Install the host's dependencies if needed (`@types/vscode` among them) and build it. */
function buildHost() {
  execFileSync(
    process.execPath,
    [join(REPO_ROOT, "scripts", "build", "build-vscode-ext-host-sidecar.mjs")],
    { cwd: REPO_ROOT, stdio: "inherit" }
  )
}

export function generateReport() {
  buildHost()
  if (!existsSync(TYPES_PATH)) {
    throw new Error(
      "sidecar/vscode-ext-host/node_modules/@types/vscode is not installed; run `npm ci` in sidecar/vscode-ext-host"
    )
  }
  const require = createRequire(join(HOST_ROOT, "package.json"))
  const { createVscodeShim, SHIM_VSCODE_API_VERSION } = require("./dist/vscode-shim/index.js")
  const { UNSUPPORTED_VSCODE_API } = require("./dist/vscode-shim/unsupported.js")
  const typesVersion = JSON.parse(readFileSync(TYPES_PACKAGE, "utf8")).version
  const errors = []
  if (typesVersion !== SHIM_VSCODE_API_VERSION) {
    errors.push(
      `@types/vscode is ${typesVersion} but the shim claims ${SHIM_VSCODE_API_VERSION}; pin them to the same version`
    )
  }
  const declared = declaredApi(readFileSync(TYPES_PATH, "utf8"))
  const shim = createVscodeShim(inertDependencies())
  const result = classify(declared, shim, UNSUPPORTED_VSCODE_API)
  const report = {
    apiVersion: SHIM_VSCODE_API_VERSION,
    summary: {
      implemented: result.report.implemented.length,
      unsupported: Object.keys(result.report.unsupported).length,
      missing: result.report.missing.length,
    },
    unsupported: result.report.unsupported,
    missing: result.report.missing,
    implemented: result.report.implemented,
    extra: result.report.extra,
  }
  return { report, errors: [...errors, ...result.errors] }
}

function main() {
  const check = process.argv.includes("--check")
  const { report, errors } = generateReport()
  for (const error of errors) console.error(`[vscode-api-coverage] ERROR ${error}`)
  const text = `${JSON.stringify(report, null, 2)}\n`
  const { implemented, unsupported, missing } = report.summary
  const summary = `${implemented} implemented, ${unsupported} unsupported, ${missing} missing (vscode ${report.apiVersion})`
  if (check) {
    const committed = existsSync(REPORT_PATH) ? readFileSync(REPORT_PATH, "utf8") : ""
    if (committed !== text) {
      console.error(
        "[vscode-api-coverage] ERROR the shim and lib/plugin/vscode-shim/vscode-api-coverage.generated.json disagree; run `pnpm vscode-api-coverage:generate` and commit the report"
      )
      process.exit(1)
    }
    if (errors.length > 0) process.exit(1)
    console.log(`[vscode-api-coverage] OK: ${summary}`)
    return
  }
  writeFileSync(REPORT_PATH, text)
  console.log(`[vscode-api-coverage] wrote ${summary}`)
  if (errors.length > 0) process.exit(1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
