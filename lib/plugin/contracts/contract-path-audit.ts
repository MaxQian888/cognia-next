// Node-only governance audit for the plugin capability contracts.
//
// `auditPluginCapabilityContracts` (plugin-capabilities.ts) runs in the
// renderer bundle, so it can only assert that a contract's proof paths are
// non-empty strings — it cannot touch the filesystem. That left a hole: a
// contract could cite `plugin-sdk/python/src/cognia/plugin.py` (a file that
// does not exist) and still be stamped `verified`.
//
// This module closes the hole with a filesystem-backed check. It imports
// `node:fs`, so it MUST stay Node-only — it is consumed by the co-located
// test (and may later back a CI gate / devtools diagnostic), never by a
// client component.

import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { PLUGIN_CAPABILITY_CONTRACTS } from "./plugin-capabilities"

/** Repo root, derived from this file's location: lib/plugin/contracts → repo. */
export const REPO_ROOT = resolve(__dirname, "..", "..", "..")

/** The contract fields whose entries are repo-relative filesystem paths. */
export type ContractPathField =
  | "hostBindings"
  | "typescriptSdk"
  | "pythonSdk"
  | "builtinContributionPaths"
  | "docs"
  | "requiredTests"

export interface PhantomContractPath {
  contractId: string
  field: ContractPathField
  /** The raw entry as written in the contract (with any anchor). */
  raw: string
  /** The repo-relative path actually probed (anchor stripped). */
  path: string
}

/**
 * Strip a trailing `#anchor` (docs) or `:line` suffix so the remaining string
 * is a probe-able filesystem path. `runtimeBinding` is intentionally excluded
 * everywhere — it is a prose description ("context.agent.registerTool + …"),
 * not a path.
 */
export function stripPathAnchor(entry: string): string {
  return entry
    .split("#")[0]
    .replace(/:\d+(?:-\d+)?$/, "")
    .trim()
}

function collectFieldPaths(
  contract: (typeof PLUGIN_CAPABILITY_CONTRACTS)[number]
): Array<{ field: ContractPathField; raw: string }> {
  const out: Array<{ field: ContractPathField; raw: string }> = []
  for (const raw of contract.hostBindings) out.push({ field: "hostBindings", raw })
  for (const raw of contract.typescriptSdk) out.push({ field: "typescriptSdk", raw })
  for (const raw of contract.pythonSdk) out.push({ field: "pythonSdk", raw })
  for (const raw of contract.builtinContributionPaths ?? []) {
    out.push({ field: "builtinContributionPaths", raw })
  }
  if (contract.docs) out.push({ field: "docs", raw: contract.docs })
  for (const raw of contract.requiredTests) out.push({ field: "requiredTests", raw })
  return out
}

/**
 * Probe every contract proof path against the working tree and return the
 * entries that do not resolve to a real file or directory.
 *
 * @param root - repo root to resolve against (overridable for tests).
 */
export function auditContractPaths(root: string = REPO_ROOT): PhantomContractPath[] {
  const phantom: PhantomContractPath[] = []
  for (const contract of PLUGIN_CAPABILITY_CONTRACTS) {
    for (const { field, raw } of collectFieldPaths(contract)) {
      const path = stripPathAnchor(raw)
      if (!path) continue
      if (!existsSync(resolve(root, path))) {
        phantom.push({ contractId: contract.id, field, raw, path })
      }
    }
  }
  return phantom
}

/**
 * Known-phantom proof paths that the contracts still cite but that do not yet
 * exist in the tree. This is a DEBT BURNDOWN list, not a permanent exception:
 *
 *   - The gate (`contract-path-audit.test.ts`) fails on any phantom NOT in
 *     this set, so no NEW phantom path can ever be introduced.
 *   - The gate also fails on any STALE entry here (one that now resolves), so
 *     fixing a path forces its removal from this set.
 *
 * The remaining entries are the genuinely-absent Python SDK tree — they are
 * burned down by building the real `plugin-sdk/python/` package (plan D-4),
 * after which this set must reach empty and the allowlist machinery removed.
 */
export const KNOWN_PHANTOM_PATHS: ReadonlySet<string> = new Set<string>([])

/** Phantom paths that are NOT in the burndown allowlist — these fail the gate. */
export function newPhantomPaths(root: string = REPO_ROOT): PhantomContractPath[] {
  return auditContractPaths(root).filter((p) => !KNOWN_PHANTOM_PATHS.has(p.path))
}

/** Allowlist entries that now resolve on disk — these must be removed. */
export function stalePhantomAllowlist(root: string = REPO_ROOT): string[] {
  const stillPhantom = new Set(auditContractPaths(root).map((p) => p.path))
  return [...KNOWN_PHANTOM_PATHS].filter((p) => !stillPhantom.has(p)).sort()
}

/** Group a phantom list by contract id → human-readable lines (for failures). */
export function formatPhantomReport(phantom: PhantomContractPath[]): string {
  const byContract = new Map<string, PhantomContractPath[]>()
  for (const p of phantom) {
    const list = byContract.get(p.contractId) ?? []
    list.push(p)
    byContract.set(p.contractId, list)
  }
  const lines: string[] = []
  for (const [id, list] of byContract) {
    lines.push(`  [${id}]`)
    for (const p of list) lines.push(`    ${p.field}: ${p.path}`)
  }
  return lines.join("\n")
}
