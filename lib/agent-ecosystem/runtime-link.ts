/**
 * The one file in this module that reads the runtime catalog.
 *
 * `./catalog` stores which runtimes an ecosystem owns. It does not store what
 * they are called or which presets they expose, because
 * `protocol/external-agent-runtimes.json` already does, behind a gate
 * (`scripts/gates/check-external-agent-runtimes.mjs`). Everything here is a
 * lookup through `lib/ai/agent/external/runtime-catalog`, never a second copy.
 *
 * That catalog imports only two checked-in JSON files and types, so this file
 * stays safe for the fast `node` Jest project.
 */

import { findRuntimeById } from "@/lib/ai/agent/external/runtime-catalog"

import {
  AGENT_ECOSYSTEMS,
  findEcosystemById,
  findEcosystemByMigrationVendor,
  primaryRuntimeIdForMigrationVendor,
} from "./catalog"

// Built once. `presetIdsForSessionSource` is called per row when the support
// matrix renders, and a linear scan per row is the kind of thing that only
// looks free until a plugin registers a dozen more sources.
const ECOSYSTEM_ID_BY_SOURCE: ReadonlyMap<string, string> = new Map(
  AGENT_ECOSYSTEMS.flatMap((entry) =>
    entry.sessionSourceIds.map((sourceId) => [sourceId, entry.id] as const)
  )
)

/** Every preset id an ecosystem can launch, primary runtime's presets first. */
export function presetIdsForEcosystem(ecosystemId: string): string[] {
  const entry = findEcosystemById(ecosystemId)
  if (!entry) return []
  return entry.runtimeIds.flatMap((runtimeId) => findRuntimeById(runtimeId)?.presetIds ?? [])
}

/** The preset a "connect this agent" offer should create, or null. */
export function primaryPresetIdForEcosystem(ecosystemId: string): string | null {
  return presetIdsForEcosystem(ecosystemId)[0] ?? null
}

/**
 * The preset id for a migration vendor.
 *
 * This replaces `VENDOR_RUNTIME`, which hard-coded four entries and got Pi
 * wrong. It wrote `"pi"`, the runtime id, where a preset id was expected, so
 * `EXTERNAL_AGENT_PRESETS` resolved nothing and an already-authenticated Pi
 * still got asked for credentials. Going through the runtime catalog makes
 * that class of mistake unrepresentable.
 */
export function primaryPresetIdForMigrationVendor(vendor: string): string | null {
  const runtimeId = primaryRuntimeIdForMigrationVendor(vendor)
  if (!runtimeId) return null
  return findRuntimeById(runtimeId)?.presetIds[0] ?? null
}

/** Every preset id a migration vendor's ecosystem can launch. */
export function presetIdsForMigrationVendor(vendor: string): string[] {
  const entry = findEcosystemByMigrationVendor(vendor)
  return entry ? presetIdsForEcosystem(entry.id) : []
}

/** Every preset id the ecosystem owning this session source can launch. */
export function presetIdsForSessionSource(sourceId: string): string[] {
  const ecosystemId = ECOSYSTEM_ID_BY_SOURCE.get(sourceId)
  return ecosystemId ? presetIdsForEcosystem(ecosystemId) : []
}

/** The catalog's display name for an ecosystem, via its primary runtime. */
export function displayNameForEcosystem(ecosystemId: string): string | null {
  const runtimeId = findEcosystemById(ecosystemId)?.runtimeIds[0]
  if (!runtimeId) return null
  return findRuntimeById(runtimeId)?.displayName ?? null
}

/**
 * The display name a migration vendor should be labelled with.
 *
 * Falls back to null rather than to the raw vendor slug. A caller with a
 * better local fallback (the migration wizard has a translated label) should
 * use it, and one without should say so rather than print an internal id.
 */
export function displayNameForMigrationVendor(vendor: string): string | null {
  const entry = findEcosystemByMigrationVendor(vendor)
  return entry ? displayNameForEcosystem(entry.id) : null
}
