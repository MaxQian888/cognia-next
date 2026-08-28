#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs"
import { extname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])
const AUTHOR_ROOTS = [
  "crates/cognia-plugin-template-ts",
  "crates/cognia-plugin-template-hybrid",
  "crates/cognia-plugin-template-vscode-extension",
  // Deep Research is the reference in-tree plugin for the public SDK: it is a
  // real, non-trivial plugin (an autonomous research loop) that nonetheless
  // compiles against `@cognia/plugin-sdk` alone. Gating it here is what keeps
  // that true — the templates prove the boundary is expressible, this proves it
  // survives a plugin big enough to be tempted across it.
  "plugins/deep-research",
]

/**
 * The `@cognia/*` packages a plugin author may import. Everything else in the
 * workspace is host-internal.
 *
 * An allowlist rather than a denylist on purpose: the repo grows packages
 * regularly, and a denylist would silently admit each new one. An author who
 * needs something from a host package needs it re-exported through the SDK,
 * where it becomes a contract instead of an accident.
 */
export const AUTHOR_PACKAGES = ["@cognia/plugin-sdk", "@cognia/plugin-ui"]

function isHostOnlyCogniaPackage(specifier) {
  if (!specifier.startsWith("@cognia/")) return false
  return !AUTHOR_PACKAGES.some(
    (allowed) => specifier === allowed || specifier.startsWith(`${allowed}/`)
  )
}

export function findForbiddenAuthorImports(source) {
  const matches = []
  const importPattern = /(?:from\s*|import\s*\(|require\s*\(|import\s+(?=["']))\s*["']([^"']+)["']/g
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1]
    if (
      specifier.startsWith("@/lib") ||
      specifier.startsWith("@/types") ||
      specifier.startsWith("@/components") ||
      specifier.startsWith("@/stores") ||
      specifier.startsWith("@/hooks") ||
      specifier.startsWith("@/plugins") ||
      specifier === "@cognia/plugin-sdk/host" ||
      specifier.startsWith("@cognia/plugin-sdk/host/") ||
      isHostOnlyCogniaPackage(specifier)
    ) {
      matches.push(specifier)
    }
  }
  return matches
}

function sourceFiles(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path)
  }
  return files
}

export function checkAuthorImports(repoRoot = process.cwd(), roots = AUTHOR_ROOTS) {
  const violations = []
  for (const root of roots.map((path) => resolve(repoRoot, path))) {
    for (const file of sourceFiles(root)) {
      for (const specifier of findForbiddenAuthorImports(readFileSync(file, "utf8"))) {
        violations.push(`${relative(repoRoot, file)} imports ${specifier}`)
      }
    }
  }
  return violations
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const requestedRoots = process.argv.slice(2)
  const violations = checkAuthorImports(
    process.cwd(),
    requestedRoots.length > 0 ? requestedRoots : AUTHOR_ROOTS
  )
  if (violations.length > 0) {
    console.error(violations.join("\n"))
    process.exitCode = 1
  } else {
    console.log("Author-facing templates contain no host-private imports.")
  }
}
