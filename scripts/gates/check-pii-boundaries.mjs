#!/usr/bin/env node
/**
 * Fail-closed audit for production modules that directly cross an AI/cloud
 * embedding boundary. A boundary module must import `@cognia/redact` or carry
 * an explicit allowlist entry that names the upstream protection (or explains
 * why the payload is intentionally outside the derived-local-data contract).
 *
 * The scanner discovers boundaries from package imports, not implementation
 * paths, so moving the redactor or a call-site file cannot silently disable it.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const ALLOWLIST = resolve(ROOT, "scripts/gates/pii-boundary-allowlist.json")
const SEARCH_ROOTS = [
  "app",
  "cli",
  "components",
  "hooks",
  "lib",
  "packages",
  "plugins",
  "sidecar",
  "stores",
  "types",
]
const REDACT_PACKAGE = "@cognia/redact"

export function extractImports(source) {
  const imports = []
  const patterns = [
    /(?:^|\n)\s*import\s+(?!type\b)[^;'\"]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) imports.push(match[1])
  }
  return [...new Set(imports)]
}

export function isAiBoundary(moduleName) {
  return (
    moduleName === "ai" ||
    moduleName.startsWith("@ai-sdk/") ||
    moduleName === "@cognia/provider-embedding/embedding"
  )
}

export function auditFile(file, source, allowlist) {
  const imports = extractImports(source)
  const boundaries = imports.filter(isAiBoundary)
  if (boundaries.length === 0 || imports.includes(REDACT_PACKAGE)) return []
  return boundaries
    .filter(
      (boundary) =>
        !allowlist.some((entry) => entry.file === file && entry.boundaries.includes(boundary))
    )
    .map((boundary) => ({ file, boundary }))
}

function productionFiles(root) {
  const output = execFileSync("git", ["-C", root, "ls-files", ...SEARCH_ROOTS], {
    encoding: "utf8",
  })
  return output
    .split("\n")
    .filter((file) => /\.(?:[cm]?[jt]s|tsx)$/.test(file))
    .filter((file) => !/\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(file))
    .filter((file) => !file.includes("/__tests__/") && !file.includes("/__mocks__/"))
}

function loadAllowlist(path) {
  const value = JSON.parse(readFileSync(path, "utf8"))
  if (!Array.isArray(value)) throw new Error("PII boundary allowlist must be an array")
  for (const [index, entry] of value.entries()) {
    if (
      !entry?.file ||
      !Array.isArray(entry?.boundaries) ||
      !entry.boundaries.length ||
      !entry?.reason ||
      !entry?.protection
    ) {
      throw new Error(
        `PII boundary allowlist entry ${index} requires file, boundaries, reason, and protection`
      )
    }
  }
  return value
}

export function runAudit(root = ROOT, allowlistPath = ALLOWLIST) {
  if (!existsSync(allowlistPath))
    throw new Error(`Missing PII boundary allowlist: ${allowlistPath}`)
  const allowlist = loadAllowlist(allowlistPath)
  const files = productionFiles(root)
  const violations = []
  const used = new Set()
  for (const file of files) {
    const source = readFileSync(resolve(root, file), "utf8")
    const imports = extractImports(source)
    for (const [index, entry] of allowlist.entries()) {
      if (entry.file === file && entry.boundaries.every((boundary) => imports.includes(boundary)))
        used.add(index)
    }
    violations.push(...auditFile(file, source, allowlist))
  }
  const stale = allowlist.filter((_, index) => !used.has(index))
  return { files, violations, stale, allowlist }
}

function main() {
  const { files, violations, stale, allowlist } = runAudit()
  if (stale.length) {
    console.error(`[pii-boundaries] ${stale.length} stale allowlist entry/entries:`)
    for (const entry of stale) console.error(`  ${entry.file} -> ${entry.boundaries.join(", ")}`)
  }
  if (violations.length) {
    console.error(`[pii-boundaries] ${violations.length} unreviewed AI/cloud boundary import(s):`)
    for (const violation of violations)
      console.error(`  ${violation.file} -> ${violation.boundary}`)
    console.error(
      "Import @cognia/redact at the boundary or add a reviewed allowlist entry with its protection."
    )
  }
  if (stale.length || violations.length) return 1
  console.log(
    `[pii-boundaries] OK: ${files.length} production files audited; ${allowlist.length} reviewed exception(s).`
  )
  return 0
}

const direct =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (direct) process.exit(main())
