/**
 * General-purpose plugin builders must leave the host's shared modules external.
 * The host whitelist is authoritative; named SDK subpaths fold into a wildcard.
 * Only the Rust CLI also externalises react-dom, so an installed transitive copy
 * cannot become a second reconciler. The loader still refuses that module.
 *
 * The first-party distribution builder now owns browser builtin bundles too.
 * Plugin-specific legacy build scripts are not general-purpose author builders.
 * Read declarations without importing the builder and evaluating plugin metadata.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
export const SHARED_MODULES_SOURCE = "lib/plugin/core/shared-modules.ts"
export const ESBUILD_EXTERNALS_SOURCE = "crates/cognia-cli/src/engine/frontend_build.rs"
export const SDK_SUBPATH_WILDCARD = "@cognia/plugin-sdk/*"
export const BUILDER_ONLY_EXTERNALS = ["react-dom"]
export const BUILD_SCRIPT_SURFACES = [
  { path: "crates/cognia-plugin-template-ts/package.json", kind: "build-script" },
  { path: "scripts/plugin/build-frontend-plugins.mjs", kind: "shared-array" },
]
export const NO_BUILD_SCRIPT_SURFACES = [
  "crates/cognia-plugin-template-vscode-extension/package.json",
]
export const NO_PACKAGE_JSON_SURFACES = [
  "crates/cognia-plugin-template-hybrid",
  "crates/cognia-plugin-template-python",
]

const read = (path, root) => readFileSync(resolve(root, path), "utf8")

function arrayEntries(source, marker, label) {
  const parts = source.split(marker)
  if (parts.length !== 2) throw new Error(`${label}: expected one ${marker}; parser is stale`)
  const body = parts[1]
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n")
    .split("]")[0]
  const entries = body
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (!entries.length) throw new Error(`${label}: parsed zero externals; parser is stale`)
  return entries
}

function literal(entry, label) {
  if (!/^"[^"\\]+"$/.test(entry))
    throw new Error(`${label}: unsupported external expression ${entry}; parser is stale`)
  return JSON.parse(entry)
}

function stringArray(source, marker, label) {
  return arrayEntries(source, marker, label).map((entry) => literal(entry, label))
}

export function readSharedModules(root = REPO_ROOT) {
  return stringArray(
    read(SHARED_MODULES_SOURCE, root),
    "PLUGIN_SHARED_MODULES = [",
    SHARED_MODULES_SOURCE
  )
}

export function readEsbuildExternals(root = REPO_ROOT) {
  return stringArray(
    read(ESBUILD_EXTERNALS_SOURCE, root),
    "const ESBUILD_EXTERNALS: &[&str] = &[",
    ESBUILD_EXTERNALS_SOURCE
  )
}

export function readBuildScriptExternals(path, root = REPO_ROOT) {
  const build = JSON.parse(read(path, root)).scripts?.build
  if (typeof build !== "string") throw new Error(`${path}: missing build script`)
  const entries = [...build.matchAll(/--external:([^\s"']+)/g)].map((match) => match[1])
  if (!entries.length) throw new Error(`${path}: parsed zero externals; parser is stale`)
  return entries
}

export function readSurfaceExternals({ path, kind }, root = REPO_ROOT) {
  if (kind === "build-script") return readBuildScriptExternals(path, root)
  if (kind !== "shared-array") throw new Error(`${path}: unknown surface kind ${kind}`)
  const source = read(path, root)
  const shared = stringArray(source, "export const SHARED_MODULES = [", path)
  return arrayEntries(source, "external: [", path).flatMap((entry) =>
    entry === "...SHARED_MODULES" ? shared : [literal(entry, path)]
  )
}

export function bundlerExternalsFor(shared) {
  return [
    ...shared.filter((entry) => !entry.startsWith("@cognia/plugin-sdk/")),
    ...(shared.some(
      (entry) => entry === "@cognia/plugin-sdk" || entry.startsWith("@cognia/plugin-sdk/")
    )
      ? [SDK_SUBPATH_WILDCARD]
      : []),
  ]
}

function differences(expected, actual) {
  const missing = expected.filter((entry) => !actual.includes(entry))
  const extra = actual.filter((entry) => !expected.includes(entry))
  const duplicates = [...new Set(actual.filter((entry, index) => actual.indexOf(entry) !== index))]
  return [
    missing.length ? `missing: ${missing.join(", ")}` : "",
    extra.length ? `extra: ${extra.join(", ")}` : "",
    duplicates.length ? `duplicate: ${duplicates.join(", ")}` : "",
  ].filter(Boolean)
}

export function findExternalsDrift(root = REPO_ROOT) {
  const problems = []
  const shared = readSharedModules(root)
  const expected = bundlerExternalsFor(shared)
  const check = (path, actual, allowed) => {
    const drift = differences(allowed, actual)
    if (drift.length) problems.push(`${path}: ${drift.join("; ")}`)
  }
  check(SHARED_MODULES_SOURCE, shared, [...new Set(shared)])
  check(ESBUILD_EXTERNALS_SOURCE, readEsbuildExternals(root), [
    ...expected,
    ...BUILDER_ONLY_EXTERNALS,
  ])
  for (const surface of BUILD_SCRIPT_SURFACES)
    check(surface.path, readSurfaceExternals(surface, root), expected)
  for (const path of NO_BUILD_SCRIPT_SURFACES) {
    if (typeof JSON.parse(read(path, root)).scripts?.build === "string")
      problems.push(`${path}: gained a build script; add its owner to BUILD_SCRIPT_SURFACES`)
  }
  for (const path of NO_PACKAGE_JSON_SURFACES) {
    if (existsSync(resolve(root, path, "package.json")))
      problems.push(`${path}: gained package.json; review and register its build owner`)
  }
  return problems
}
