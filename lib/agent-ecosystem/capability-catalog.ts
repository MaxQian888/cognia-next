/**
 * Capability rows owned by integration packages (ADR-0217).
 *
 * `protocol/agent-capabilities.json` is the ADR-0090 capability manifest the
 * renderer, CLI, TUI and gates read. A protocol implemented by an integration
 * package has its row (and its presets' refinements) authored in that
 * package's `./manifest` as an `AgentCapabilityContribution`;
 * `scripts/build/gen-agent-capabilities.mjs` writes them into the file and
 * `--check` fails on drift. Rows nobody contributes stay authored in the file.
 */

import { A2A_CAPABILITIES } from "@cognia/agent-a2a/manifest"
import { ACP_CAPABILITIES } from "@cognia/agent-acp/manifest"
import { AIDER_CAPABILITIES } from "@cognia/agent-aider/manifest"
import { CODEX_CAPABILITIES } from "@cognia/agent-codex/manifest"
import type {
  AgentCapabilityContribution,
  AgentPresetCapabilityRefinement,
  AgentProtocolCapabilityRow,
} from "@cognia/agent-contracts/ecosystem"
import { DSH_CAPABILITIES } from "@cognia/agent-dsh/manifest"
import { OPENCODE_CAPABILITIES } from "@cognia/agent-opencode/manifest"
import { PI_CAPABILITIES } from "@cognia/agent-pi/manifest"

/** Every package's capability contribution. */
export const INTEGRATION_CAPABILITIES: readonly AgentCapabilityContribution[] = [
  ACP_CAPABILITIES,
  CODEX_CAPABILITIES,
  DSH_CAPABILITIES,
  PI_CAPABILITIES,
  OPENCODE_CAPABILITIES,
  A2A_CAPABILITIES,
  AIDER_CAPABILITIES,
]

/** The persisted manifest; only the two contributed sections are typed here. */
export interface CapabilityManifestFile {
  protocols: Record<string, AgentProtocolCapabilityRow>
  presetRefinements: Record<string, AgentPresetCapabilityRefinement>
  [section: string]: unknown
}

function mergeSection<T>(
  current: Record<string, T>,
  contributed: Map<string, T>
): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [key, value] of Object.entries(current)) {
    out[key] = structuredClone(contributed.get(key) ?? value)
  }
  for (const [key, value] of contributed) {
    if (!(key in out)) out[key] = structuredClone(value)
  }
  return out
}

/**
 * The manifest with every contributed protocol row and preset refinement
 * taken from its package. Existing keys keep their position; new ones are
 * appended. Throws when two packages contribute one key, or a refinement names
 * a protocol that has no row.
 */
export function mergeIntegrationCapabilityRows(
  manifest: CapabilityManifestFile,
  contributions: readonly AgentCapabilityContribution[]
): CapabilityManifestFile {
  const protocols = new Map<string, AgentProtocolCapabilityRow>()
  const refinements = new Map<string, AgentPresetCapabilityRefinement>()
  for (const contribution of contributions) {
    for (const [protocol, row] of Object.entries(contribution.protocols ?? {})) {
      if (protocols.has(protocol)) throw new Error(`protocol ${protocol} has two capability rows`)
      protocols.set(protocol, row)
    }
    for (const [preset, refinement] of Object.entries(contribution.presetRefinements ?? {})) {
      if (refinements.has(preset))
        throw new Error(`preset ${preset} has two capability refinements`)
      refinements.set(preset, refinement)
    }
  }
  const merged: CapabilityManifestFile = {
    ...manifest,
    protocols: mergeSection(manifest.protocols, protocols),
    presetRefinements: mergeSection(manifest.presetRefinements, refinements),
  }
  for (const [preset, refinement] of refinements) {
    if (!(refinement.protocol in merged.protocols)) {
      throw new Error(
        `preset ${preset} refines ${refinement.protocol}, which has no capability row`
      )
    }
  }
  return merged
}
