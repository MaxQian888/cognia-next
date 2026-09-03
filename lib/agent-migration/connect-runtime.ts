/**
 * After a migration, which external-agent connection would run this vendor.
 *
 * Migration brings a coding agent's settings, commands, subagents and history
 * into Cognia, and then stops. Nothing offered to actually connect the agent,
 * so a user who had just imported their whole Codex setup still had to find
 * the external-agent settings and pick the right preset out of seventeen.
 *
 * The preset comes from `lib/agent-ecosystem`, not from a local map. The map
 * that used to answer this question (`VENDOR_RUNTIME`) held a runtime id where
 * a preset id belonged and resolved to nothing for Pi.
 *
 * Pure and store-free so it stays in the fast `node` Jest project. The caller
 * supplies the configs it already has.
 */

import { primaryPresetIdForMigrationVendor } from "@/lib/agent-ecosystem/runtime-link"
import { externalAgentPresetIdOf } from "@/lib/ai/agent/external/preset-identity"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

export interface RuntimeConnectionPlan {
  presetId: string
  /** Set when a config for this preset already exists, so we offer to open it. */
  existingAgentId: string | null
}

export interface PlanRuntimeConnectionInput {
  vendor: string
  /** Every saved external-agent config, keyed by id. */
  existingConfigs: Readonly<Record<string, Pick<ExternalAgentConfig, "metadata">>>
  /**
   * What the migration actually imported, per artifact.
   *
   * Used only to decide whether to offer at all. A run where every category was
   * already shared, empty or unsupported moved nothing, and offering to
   * connect a runtime off the back of it reads as a result the user did not get.
   */
  importedCounts?: readonly number[]
}

/**
 * The connection to offer, or null when there is nothing worth offering.
 *
 * Null for a vendor with no launchable runtime, and null when the migration
 * imported nothing.
 */
export function planRuntimeConnection({
  vendor,
  existingConfigs,
  importedCounts,
}: PlanRuntimeConnectionInput): RuntimeConnectionPlan | null {
  if (importedCounts && !importedCounts.some((count) => count > 0)) return null

  const presetId = primaryPresetIdForMigrationVendor(vendor)
  if (!presetId) return null

  // `addAgentFromPreset` creates unconditionally and does not dedupe, so a
  // second migration would otherwise leave two identical connections.
  const existing = Object.entries(existingConfigs).find(
    ([, config]) => externalAgentPresetIdOf(config) === presetId
  )

  return { presetId, existingAgentId: existing?.[0] ?? null }
}
