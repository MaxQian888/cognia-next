#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs"
import { extname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])
const AUTHOR_ROOTS = [
  "crates/cognia-plugin-template-ts",
  "crates/cognia-plugin-template-hybrid",
  "crates/cognia-plugin-template-vscode-extension",
]

export function findForbiddenAuthorImports(source) {
  const matches = []
  const importPattern = /(?:from\s*|import\s*\(|require\s*\(|import\s+(?=["']))\s*["']([^"']+)["']/g
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1]
    if (
      specifier.startsWith("@/lib") ||
      specifier.startsWith("@/types") ||
      specifier === "@cognia/plugin-sdk/host" ||
      specifier.startsWith("@cognia/plugin-sdk/host/")
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

export function checkAuthorImports(repoRoot = process.cwd()) {
  const violations = []
  for (const root of AUTHOR_ROOTS.map((path) => resolve(repoRoot, path))) {
    for (const file of sourceFiles(root)) {
      for (const specifier of findForbiddenAuthorImports(readFileSync(file, "utf8"))) {
        violations.push(`${relative(repoRoot, file)} imports ${specifier}`)
      }
    }
  }
  return violations
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = checkAuthorImports()
  if (violations.length > 0) {
    console.error(violations.join("\n"))
    process.exitCode = 1
  } else {
    console.log("Author-facing templates contain no host-private imports.")
  }
}
