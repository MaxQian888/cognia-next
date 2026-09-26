#!/usr/bin/env node
// ADR-0090 gate: no vendor-name special cases in the unified execution path.
//
// The plan's Phase 4 acceptance ("全链路不存在 GLM/Kimi/provider-name branch")
// must hold DURABLY, not once: this gate greps the execution-path directories
// for vendor names and fails when one appears outside the allowlisted data /
// legacy-reader locations.
//
// Usage: node scripts/gates/check-provider-name-branches.mjs
// Exit 0 = clean; exit 1 = violations printed.

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

export const VENDOR_PATTERN = "glm|kimi|zhipu|moonshot|minimax"

/**
 * Where the sidecar's execution path lives. ADR-0197 moves `dispatch/` into
 * `src/` layer by layer, so either (or both) may exist; at least one must.
 */
export const SIDECAR_EXECUTION_PATHS = ["sidecar/dispatch", "sidecar/src"]

/** Execution-path directories that must stay vendor-neutral. */
export const SCANNED_PATHS = [
  ...SIDECAR_EXECUTION_PATHS,
  "crates/cognia-gateway/src",
  "lib/ai/agent/execution",
  "lib/gateway",
  // ADR-0163: the provider operation dispatcher resolves handlers by
  // provider id, protocol, then any. Never by a vendor-name branch.
  "lib/ai/operations",
]

/**
 * Allowlisted files: pure DATA (catalog metadata, migration fixtures/tests
 * that must name legacy ids) and documentation. Never dispatch logic.
 */
export const ALLOWLIST = [
  // Migration fixtures/tests reference legacy relay ids as DATA.
  /legacy-mapping\.test\.ts$/,
  /resolve-agent-execution-spec\.test\.ts$/,
  // The legacy-mapping implementation embeds the vendor names ONLY inside
  // comments/tests guards; its own test asserts the code is table-free.
]

/**
 * The scanned paths that exist. A path that vanished would otherwise be
 * scanned as "no matches" — the gate going blind while reporting clean — so a
 * missing non-sidecar path, or both sidecar paths missing, is an error.
 */
export function resolveScanPaths({
  cwd = process.cwd(),
  exists = (p) => existsSync(join(cwd, p)),
} = {}) {
  const present = SCANNED_PATHS.filter(exists)
  const missing = SCANNED_PATHS.filter(
    (p) => !present.includes(p) && !SIDECAR_EXECUTION_PATHS.includes(p)
  )
  if (missing.length > 0) {
    throw new Error(`scanned path(s) no longer exist: ${missing.join(", ")} — update SCANNED_PATHS`)
  }
  if (!SIDECAR_EXECUTION_PATHS.some((p) => present.includes(p))) {
    throw new Error(
      `none of ${SIDECAR_EXECUTION_PATHS.join(", ")} exists — update SIDECAR_EXECUTION_PATHS`
    )
  }
  return present
}

export function findViolations({ cwd = process.cwd() } = {}) {
  let raw = ""
  try {
    raw = execFileSync(
      "rg",
      ["-n", "-i", VENDOR_PATTERN, ...resolveScanPaths({ cwd }), "--no-messages"],
      {
        cwd,
        encoding: "utf8",
      }
    )
  } catch (error) {
    // rg exits 1 on zero matches — that's the clean case.
    if (error.status === 1) return []
    throw error
  }
  const lines = raw.split("\n").filter(Boolean)
  return lines.filter((line) => {
    const file = line.split(":", 1)[0]
    return !ALLOWLIST.some((pattern) => pattern.test(file))
  })
}

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())
if (isEntry) {
  const violations = findViolations()
  if (violations.length > 0) {
    console.error("[check-provider-name-branches] vendor-name references in execution paths:")
    for (const line of violations) console.error(`  ${line}`)
    console.error(
      "\nVendor behavior belongs in catalog DATA / compatibility records, never in dispatch logic (ADR-0090)."
    )
    process.exit(1)
  }
  console.log("[check-provider-name-branches] OK — execution paths are vendor-neutral")
}
