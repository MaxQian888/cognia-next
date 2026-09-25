#!/usr/bin/env node

// Keep the compiled output of every workspace package the Claude sidecar links
// current, and prove the sidecar's runtime imports of them reach that output.
//
// The sidecar depends on first-party packages through `link:../packages/<x>`
// (sidecar/package.json). In a checkout the link is a symlink, so Node follows
// it out of `node_modules` and strips the package's TypeScript source happily.
// The Tauri bundle is different: `copy_resources` dereferences symlinks while
// staging `../sidecar/node_modules/**/*`, so the shipped copy is real files
// UNDER `node_modules`, and Node refuses to strip types there
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). The desktop sidecar then dies
// at its first import. Each linked package therefore routes the `node` export
// condition to a tsup-compiled `dist/`, which this script builds (only when a
// source moved, ADR-0068 C4) and then verifies.
//
// Runs from the root postinstall, `predev`, `prebuild`, and `sidecar:test`.

import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { execaSync } from "execa"

import { buildLinkedPackages } from "./lib/build-linked-packages.mjs"

const LABEL = "build-sidecar-linked-packages"
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const sidecarRoot = join(repoRoot, "sidecar")

// Nested packages with their own manifests, lockfiles and linked-package
// handling, plus the generated MCP bundle (which inlines its imports).
const SCAN_EXCLUDES = new Set(["node_modules", "vscode-ext-host", "webclone", "codeserver-agent-ext"])
const GENERATED = new Set(["cognia-mcp.mjs"])

/** `link:` dependencies of `sidecar/package.json`, as absolute package dirs. */
export function linkedPackageDirs(manifest, root = sidecarRoot) {
  const deps = { ...manifest.dependencies, ...manifest.optionalDependencies }
  return Object.entries(deps)
    .filter(([, spec]) => typeof spec === "string" && spec.startsWith("link:"))
    .map(([name, spec]) => ({ name, dir: resolve(root, spec.slice("link:".length)) }))
}

/**
 * Package specifiers of `@cognia/*` that a module imports at runtime.
 * Type-only imports are erased by Node before resolution, so they are skipped.
 */
export function runtimeCogniaSpecifiers(source) {
  const found = new Set()
  const staticImport = /^\s*(import|export)\s+(?!type\s)[^;]*?\bfrom\s*["'](@cognia\/[^"']+)["']/gm
  const bareImport = /^\s*import\s*["'](@cognia\/[^"']+)["']/gm
  const dynamicImport = /\bimport\(\s*["'](@cognia\/[^"']+)["']\s*\)/g
  for (const m of source.matchAll(staticImport)) found.add(m[2])
  for (const m of source.matchAll(bareImport)) found.add(m[1])
  for (const m of source.matchAll(dynamicImport)) found.add(m[1])
  return found
}

/** Every `@cognia/*` runtime import across the sidecar's own sources (tests included). */
export function collectSidecarCogniaSpecifiers(root = sidecarRoot) {
  const found = new Set()
  const walk = (dir, top) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (top && (SCAN_EXCLUDES.has(entry.name) || GENERATED.has(entry.name))) continue
      if (entry.name === "node_modules") continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, false)
      else if (/\.(mjs|js|ts|mts)$/.test(entry.name)) {
        for (const spec of runtimeCogniaSpecifiers(readFileSync(path, "utf8"))) found.add(spec)
      }
    }
  }
  walk(root, true)
  return [...found].sort()
}

/**
 * Resolve specifiers exactly as the sidecar process does: an ESM resolution with
 * Node's default conditions, based in the sidecar directory.
 */
export function resolveFromSidecar(specifiers, root = sidecarRoot) {
  const script =
    "const out = {};" +
    "for (const s of JSON.parse(process.argv[1])) {" +
    "  try { out[s] = import.meta.resolve(s) } catch (e) { out[s] = 'error:' + (e?.code ?? e?.message) }" +
    "}" +
    "process.stdout.write(JSON.stringify(out))"
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(specifiers)], {
    cwd: root,
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(`[${LABEL}] resolver child failed: ${result.stderr || result.status}`)
  }
  return JSON.parse(result.stdout)
}

/**
 * Specifiers whose resolution would crash the bundled sidecar: unresolvable, or
 * resolved to TypeScript that the staged `node_modules` copy cannot run.
 */
export function unshippableResolutions(resolved) {
  return Object.entries(resolved).filter(([, url]) => url.startsWith("error:") || /\.[mc]?tsx?$/.test(url))
}

function run(cmd, args, opts = {}) {
  const result = execaSync(cmd, args, { stdio: "inherit", reject: false, ...opts })
  if (result.exitCode !== 0 || result.signal) {
    process.stderr.write(`[${LABEL}] '${cmd} ${args.join(" ")}' exited with ${result.exitCode ?? result.signal}\n`)
    process.exit(result.exitCode ?? 1)
  }
}

function main() {
  const manifest = JSON.parse(readFileSync(join(sidecarRoot, "package.json"), "utf8"))
  const linked = linkedPackageDirs(manifest)
  buildLinkedPackages(
    linked.map((pkg) => pkg.dir),
    { label: LABEL, repoRoot, run }
  )

  const specifiers = collectSidecarCogniaSpecifiers()
  const bad = unshippableResolutions(resolveFromSidecar(specifiers))
  if (bad.length > 0) {
    for (const [spec, url] of bad) {
      process.stderr.write(`[${LABEL}] ${spec} resolves to ${url}\n`)
    }
    process.stderr.write(
      `[${LABEL}] the bundled sidecar cannot load these: give the package a \`node\` export ` +
        "condition that points at compiled JS, and a tsup entry that produces it.\n"
    )
    process.exit(1)
  }
  process.stdout.write(`[${LABEL}] ok (${specifiers.join(", ") || "no @cognia imports"})\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}
