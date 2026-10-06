/**
 * Runtime catalog rows owned by integration packages (ADR-0217).
 *
 * `protocol/external-agent-runtimes.json` is read by the app, Rust, the
 * sandbox image and the bundle tooling, so it stays the file everyone
 * consumes. The rows of a runtime that has an integration package are
 * authored in that package's `./manifest` (`runtimes`, plus any
 * `unpinnedLaunchWaivers`); `scripts/build/gen-external-agent-runtimes.mjs`
 * writes them into the file and `--check` fails on drift. Rows of runtimes
 * without a package stay authored in the file itself. Either way each row has
 * exactly one place it is edited.
 */

import type { AgentIntegrationManifest } from "@cognia/agent-contracts/ecosystem"
import type { ExternalAgentRuntimeCatalogEntry } from "@cognia/agent-contracts/external-agent-lifecycle"

/** The persisted catalog file, including its reviewer-facing prose. */
export interface RuntimeCatalogFile {
  version: number
  description?: string
  notes?: Record<string, string>
  unpinnedLaunchWaivers: { note?: string; runtimes: Record<string, string> }
  runtimes: ExternalAgentRuntimeCatalogEntry[]
}

/**
 * The catalog with every package-owned row and waiver taken from its manifest.
 * A row already in the file keeps its position; a new one is appended in
 * manifest order. Throws when a manifest's rows do not match its ecosystem's
 * runtime ids, or two manifests claim one runtime.
 */
export function mergeIntegrationRuntimeRows(
  catalog: RuntimeCatalogFile,
  manifests: readonly AgentIntegrationManifest[]
): RuntimeCatalogFile {
  const owned = new Map<string, ExternalAgentRuntimeCatalogEntry>()
  const ownedWaivers = new Map<string, string>()
  for (const manifest of manifests) {
    const rows = manifest.runtimes ?? []
    const ids = rows.map((row) => row.runtimeId)
    const declared = [...manifest.ecosystem.runtimeIds].sort()
    if ([...ids].sort().join("\n") !== declared.join("\n")) {
      throw new Error(
        `${manifest.ecosystem.id}: runtime rows [${ids.join(", ")}] do not match ecosystem.runtimeIds [${declared.join(", ")}]`
      )
    }
    for (const row of rows) {
      if (owned.has(row.runtimeId)) {
        throw new Error(`runtime ${row.runtimeId} is claimed by more than one manifest`)
      }
      owned.set(row.runtimeId, row)
    }
    for (const [runtimeId, reason] of Object.entries(manifest.unpinnedLaunchWaivers ?? {})) {
      if (!ids.includes(runtimeId)) {
        throw new Error(`${manifest.ecosystem.id}: waiver for ${runtimeId}, which it does not own`)
      }
      ownedWaivers.set(runtimeId, reason)
    }
  }

  const present = new Set(catalog.runtimes.map((row) => row.runtimeId))
  const runtimes = [
    ...catalog.runtimes.map((row) => owned.get(row.runtimeId) ?? row),
    ...[...owned.values()].filter((row) => !present.has(row.runtimeId)),
  ].map((row) => structuredClone(row) as ExternalAgentRuntimeCatalogEntry)

  const waivers: Record<string, string> = {}
  for (const [runtimeId, reason] of Object.entries(catalog.unpinnedLaunchWaivers.runtimes)) {
    if (!owned.has(runtimeId)) waivers[runtimeId] = reason
    else if (ownedWaivers.has(runtimeId)) waivers[runtimeId] = ownedWaivers.get(runtimeId)!
  }
  for (const [runtimeId, reason] of ownedWaivers) {
    if (!(runtimeId in waivers)) waivers[runtimeId] = reason
  }

  return {
    ...catalog,
    unpinnedLaunchWaivers: { ...catalog.unpinnedLaunchWaivers, runtimes: waivers },
    runtimes,
  }
}
