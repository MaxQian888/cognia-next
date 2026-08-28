#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
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

/**
 * Every in-tree plugin is governed by the same boundary as the templates —
 * that is the point of a first-party plugin: it is a worked example of what a
 * third party can build. The ones still carrying host-private imports are
 * listed in the baseline below, and that list may only SHRINK. A plugin that
 * has been cleaned but is still listed fails the gate too, so the record can
 * never quietly overstate how much is left.
 */
export const PLUGIN_GOVERNANCE_ROOT = "plugins"
export const PLUGIN_GOVERNANCE_BASELINE = "scripts/plugin/author-import-baseline.json"

function pluginDirs(repoRoot) {
  const root = resolve(repoRoot, PLUGIN_GOVERNANCE_ROOT)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
    .map((entry) => entry.name)
    .sort()
}

export function readGovernanceBaseline(repoRoot = process.cwd()) {
  const path = resolve(repoRoot, PLUGIN_GOVERNANCE_BASELINE)
  if (!existsSync(path)) return []
  const parsed = JSON.parse(readFileSync(path, "utf8"))
  return Array.isArray(parsed.notYetMigrated) ? parsed.notYetMigrated : []
}

/**
 * @returns {{ violations: string[], stale: string[], unlisted: string[], migrated: string[] }}
 *   `violations` — host-private imports in a plugin the baseline does not excuse.
 *   `stale`      — baselined plugins that are now clean (delete the entry).
 *   `unlisted`   — plugins in the baseline that no longer exist.
 *   `migrated`   — every plugin currently holding the line, for reporting.
 */
export function checkPluginGovernance(repoRoot = process.cwd()) {
  const baseline = new Set(readGovernanceBaseline(repoRoot))
  const dirs = pluginDirs(repoRoot)
  const violations = []
  const stale = []
  const migrated = []
  for (const dir of dirs) {
    const found = checkAuthorImports(repoRoot, [`${PLUGIN_GOVERNANCE_ROOT}/${dir}`])
    if (baseline.has(dir)) {
      if (found.length === 0) stale.push(dir)
      continue
    }
    if (found.length > 0) violations.push(...found)
    else migrated.push(dir)
  }
  const unlisted = [...baseline].filter((dir) => !dirs.includes(dir)).sort()
  return { violations, stale, unlisted, migrated }
}

export function writeGovernanceBaseline(repoRoot = process.cwd()) {
  const dirty = pluginDirs(repoRoot).filter(
    (dir) => checkAuthorImports(repoRoot, [`${PLUGIN_GOVERNANCE_ROOT}/${dir}`]).length > 0
  )
  const path = resolve(repoRoot, PLUGIN_GOVERNANCE_BASELINE)
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        $comment:
          "Plugins that still import host-private modules instead of @cognia/plugin-sdk. This list may only shrink — see scripts/plugin/check-author-imports.mjs.",
        notYetMigrated: dirty,
      },
      null,
      2
    )}\n`
  )
  return dirty
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args.includes("--write-baseline")) {
    const dirty = writeGovernanceBaseline()
    console.log(`Wrote ${PLUGIN_GOVERNANCE_BASELINE}: ${dirty.length} plugin(s) not yet migrated.`)
  } else {
    const requestedRoots = args.filter((arg) => !arg.startsWith("--"))
    if (requestedRoots.length > 0) {
      const violations = checkAuthorImports(process.cwd(), requestedRoots)
      if (violations.length > 0) {
        console.error(violations.join("\n"))
        process.exitCode = 1
      } else {
        console.log("No host-private imports in the requested roots.")
      }
    } else {
      const failures = []
      const templateViolations = checkAuthorImports()
      if (templateViolations.length > 0) failures.push(...templateViolations)

      const governance = checkPluginGovernance()
      failures.push(...governance.violations)
      for (const dir of governance.stale) {
        failures.push(
          `plugins/${dir} is clean — remove it from ${PLUGIN_GOVERNANCE_BASELINE} (the list may only shrink)`
        )
      }
      for (const dir of governance.unlisted) {
        failures.push(`${PLUGIN_GOVERNANCE_BASELINE} lists plugins/${dir}, which does not exist`)
      }

      if (failures.length > 0) {
        console.error(failures.join("\n"))
        process.exitCode = 1
      } else {
        const remaining = readGovernanceBaseline().length
        console.log(
          `Author templates and ${governance.migrated.length} in-tree plugin(s) import only the public SDK` +
            (remaining > 0 ? ` (${remaining} plugin(s) still on the baseline).` : ".")
        )
      }
    }
  }
}
