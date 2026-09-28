#!/usr/bin/env node
/**
 * Guard for `bundle.resources` in `src-tauri/tauri.conf.json`.
 *
 * Tauri stages exactly the paths that list names — nothing follows the sidecar's
 * imports. When an entry point gained a new first-party dependency and the list
 * was not updated, the staged directory kept the entry `.mjs` but lost the
 * module it imports. `claude::sidecar::packaged_sidecar_dir` accepts a directory
 * on the presence of its `REQUIRED_SIDECAR_ENTRIES`, so that half-staged copy is
 * preferred over the complete checkout, node exits with `ERR_MODULE_NOT_FOUND`,
 * and the app falls into recovery safe mode.
 *
 * This module walks the real runtime import graph so the mismatch fails a test
 * instead of a packaged build. It fails CLOSED: an import it cannot resolve, a
 * file type it does not know, a package the owning package.json does not
 * declare, or a Rust required entry the resources do not stage is a finding —
 * never silently skipped.
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { isBuiltin } from "node:module"
import path from "node:path"
import ts from "typescript"

/** Entry points Tauri stages and the Rust host (or Pi) loads by path. */
export const SIDECAR_ENTRY_POINTS = [
  "sidecar/agent-host.mjs",
  "sidecar/claude-host.mjs",
  "sidecar/a2ui-mcp.mjs",
  "sidecar/cognia-mcp.mjs",
  "sidecar/mcp-oauth-helper.mjs",
  "sidecar/mcp-stdio-relay.mjs",
  "sidecar/codex-app-control/control-cli.mjs",
  "sidecar/pi-extension/cognia-pi-extension.ts",
]

/**
 * Build outputs the closure may reference before they exist: `prebuild` writes
 * them, so a fresh clone does not have them yet. They join the closure (the
 * resources must still stage them) but are never walked: each is either a
 * self-contained bundle or a package with its own packaging checks.
 */
export const GENERATED_FILES = ["sidecar/cognia-mcp.mjs"]
export const GENERATED_DIRS = [
  "sidecar/webclone/dist/",
  "sidecar/vscode-ext-host/dist/",
  "sidecar/src/services/code-graph/grammars/",
]

/**
 * Bare imports the owning package.json deliberately does not declare, with the
 * reason. Each is loaded behind a fallback, so its absence is not a crash.
 */
export const OPTIONAL_UNDECLARED = {
  "@vscode/ripgrep": "probed by src/tools/builtin/core-files/rg.ts after the system rg; the import is caught and falls back",
}

const SCRIPT_EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".ts", ".mts", ".cts"])
const DATA_EXTENSIONS = new Set([".json", ".sql", ".wasm", ".node"])

const isGenerated = (rel) => GENERATED_FILES.includes(rel) || GENERATED_DIRS.some((dir) => rel.startsWith(dir))

/**
 * Runtime module references in one source file. Type-only imports and exports
 * are erased before Node resolves anything, so they are not references.
 * `new URL("./x", import.meta.url)` names a file the module reads or spawns at
 * runtime (a worker, the sandbox child), so it is one — but a soft one: the
 * relay locates its sibling under two layouts, and only one exists per layout.
 *
 * @returns {{ imports: string[], fileUrls: string[] }}
 */
export function runtimeReferences(fileName, source) {
  const kind = /\.[mc]?tsx?$/.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind)
  const imports = []
  const fileUrls = []
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) imports.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) imports.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text)
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.length === 2 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text.startsWith(".") &&
      node.arguments[1].getText(sf) === "import.meta.url"
    ) {
      fileUrls.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { imports, fileUrls }
}

/** Package name of a bare specifier (`@scope/pkg/sub` → `@scope/pkg`). */
export function packageNameOf(specifier) {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

/** Repo-relative files git knows about (tracked, or new and not ignored). */
function knownFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
  return new Set(out.split("\0").filter(Boolean))
}

/** The package.json that owns `rel` (nearest ancestor, not above the repo root). */
function owningManifest(root, rel, cache) {
  let dir = path.dirname(rel)
  while (dir && dir !== ".") {
    const candidate = path.join(dir, "package.json")
    if (!cache.has(candidate)) {
      const abs = path.join(root, candidate)
      cache.set(candidate, fs.existsSync(abs) ? JSON.parse(fs.readFileSync(abs, "utf8")) : null)
    }
    const manifest = cache.get(candidate)
    if (manifest) return { file: candidate, manifest }
    dir = path.dirname(dir)
  }
  return null
}

const declares = (manifest, name) =>
  [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies].some(
    (deps) => deps && Object.hasOwn(deps, name)
  )

/**
 * Walk the runtime import graph from the entry points.
 *
 * @returns {{ files: Set<string>, problems: string[] }} `files` is every
 *   repo-relative file the packaged sidecar needs; `problems` are the reasons
 *   the graph cannot be trusted (each one would crash, or silently mis-stage, a
 *   packaged sidecar).
 */
export function analyzeSidecarClosure(root, entryPoints = SIDECAR_ENTRY_POINTS) {
  const known = knownFiles(root)
  const manifests = new Map()
  const files = new Set()
  const problems = []
  const seen = new Set()

  const walk = (rel, via) => {
    if (seen.has(rel)) return
    seen.add(rel)
    const present = known.has(rel) && fs.existsSync(path.join(root, rel))
    if (!present) {
      if (isGenerated(rel) || via === null) files.add(rel)
      else problems.push(`${via} imports ${rel}, which is neither a known file nor a declared build output`)
      return
    }
    files.add(rel)
    const ext = path.extname(rel)
    if (DATA_EXTENSIONS.has(ext) || isGenerated(rel)) return
    if (!SCRIPT_EXTENSIONS.has(ext)) {
      problems.push(`${via ?? rel} reaches ${rel}, whose extension ${ext || "(none)"} is not a runtime file type`)
      return
    }

    const { imports, fileUrls } = runtimeReferences(rel, fs.readFileSync(path.join(root, rel), "utf8"))
    for (const specifier of imports) {
      if (specifier.startsWith(".")) {
        walk(path.normalize(path.join(path.dirname(rel), specifier)), rel)
      } else if (specifier.startsWith("/") || /^[a-z]+:/i.test(specifier)) {
        if (!isBuiltin(specifier)) problems.push(`${rel} imports ${specifier} by absolute path or URL`)
      } else if (!isBuiltin(specifier)) {
        const name = packageNameOf(specifier)
        if (Object.hasOwn(OPTIONAL_UNDECLARED, name)) continue
        const owner = owningManifest(root, rel, manifests)
        if (!owner || !declares(owner.manifest, name)) {
          problems.push(
            `${rel} imports ${specifier}, but ${owner?.file ?? "no package.json"} does not declare ${name} ` +
              "(the bundle ships only the owning package's node_modules)"
          )
        }
      }
    }
    for (const url of fileUrls) {
      const target = path.normalize(path.join(path.dirname(rel), url))
      if (known.has(target) || isGenerated(target)) walk(target, rel)
    }
  }

  entryPoints.forEach((entry) => walk(entry, null))
  return { files, problems }
}

/** Every repo-relative file the entry points need at runtime. */
export function computeSidecarClosure(root, entryPoints = SIDECAR_ENTRY_POINTS) {
  return analyzeSidecarClosure(root, entryPoints).files
}

/**
 * Turn one `bundle.resources` entry into a predicate over repo-relative paths.
 * Entries are written relative to `src-tauri/`, so `../sidecar/x` is the repo's
 * `sidecar/x`. Only `*` and `**` appear in this config; both are translated here
 * rather than pulling in a glob dependency.
 */
export function resourceMatcher(entry) {
  const rel = path.normalize(path.join("src-tauri", entry))
  const escaped = rel.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  const pattern = escaped
    .replace(/\*\*\/\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*")
  const regex = new RegExp(`^${pattern}$`)
  return (candidate) => regex.test(candidate)
}

/** Closure members that no `bundle.resources` entry stages. */
export function findUncoveredResources(root, resources, entryPoints = SIDECAR_ENTRY_POINTS) {
  const matchers = resources.map(resourceMatcher)
  return [...computeSidecarClosure(root, entryPoints)]
    .filter((file) => !matchers.some((matches) => matches(file)))
    .sort()
}

/** `REQUIRED_SIDECAR_ENTRIES` as declared in the Rust host. */
export function requiredSidecarEntries(root) {
  const source = fs.readFileSync(path.join(root, "crates/cognia-sidecar/src/lib.rs"), "utf8")
  const block = source.match(/const REQUIRED_SIDECAR_ENTRIES: &\[&str\] = &\[([\s\S]*?)\];/)
  if (!block) throw new Error("REQUIRED_SIDECAR_ENTRIES not found in crates/cognia-sidecar/src/lib.rs")
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

/**
 * Rust's required entries that the checkout lacks or the resources do not
 * stage. A required entry that is never staged means every packaged directory
 * is rejected; one the checkout lacks means the rule and the tree disagree.
 */
export function findUnstagedRequiredEntries(root, resources) {
  const matchers = resources.map(resourceMatcher)
  const staged = (candidate) => matchers.some((matches) => matches(candidate))
  const problems = []
  for (const entry of requiredSidecarEntries(root)) {
    const rel = `sidecar/${entry}`
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) {
      problems.push(`${rel} is required by the Rust host but missing from the checkout`)
      continue
    }
    const probe = fs.statSync(abs).isDirectory() ? `${rel}/__probe__.mjs` : rel
    if (!staged(probe)) problems.push(`${rel} is required by the Rust host but no bundle.resources entry stages it`)
  }
  return problems
}
