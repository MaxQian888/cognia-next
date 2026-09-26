/**
 * The agent-profile fields the character editor's "Advanced overrides" area
 * owns. Every one of them overrides an app-level (or built-in) default that
 * `resolveSendOptions` / the connector binding resolver falls back to when the
 * field is `undefined`, so "inherit" is always represented as `undefined` and
 * never as a sentinel value.
 *
 * The editor keeps these values verbatim — it never re-derives them from a
 * display projection — so loading an agent and saving it unchanged writes back
 * exactly what was stored. That matters twice over for variants (ADR-0199):
 * `updateCharacter` decides which fields a variant owns by diffing the saved
 * profile against its base, so any normalisation here would make a variant
 * start owning fields it never changed.
 *
 * `embeddingProviderId` is deliberately NOT listed: embeddings belong to the
 * twin whose vectors they build (one twin can back several agents), so the
 * twin Workbench owns that setting. The field is left untouched on save
 * because the editor's patch never carries it.
 */

import type { Character } from "@cognia/agent-config-types"

export const AGENT_OVERRIDE_FIELDS = [
  "providerId",
  "sandboxPolicy",
  "toolFilter",
  "toolSearchRuntimeOverride",
  "compactionOverride",
  "instructionsOverride",
  "outputStyle",
  "customOutputStyle",
  "maxThinkingTokens",
  "a2uiEnabled",
  "a2uiCatalogId",
  "enableOcr",
  "enableBuiltInSkills",
  "disablePluginTools",
  "workspaceConfinementEnabled",
  "platformDefaults",
] as const satisfies ReadonlyArray<keyof Character>

export type AgentOverrideField = (typeof AGENT_OVERRIDE_FIELDS)[number]

/** Every override field, each either the agent's own value or `undefined` (inherit). */
export type AgentOverrides = { [K in AgentOverrideField]: Character[K] | undefined }

/**
 * Copy the override fields out of an agent profile (or an editor state) into a
 * record that carries every key. Values are passed through by reference, so an
 * untouched field is the very object that was loaded.
 */
export function pickAgentOverrides(
  source: Partial<Pick<Character, AgentOverrideField>>
): AgentOverrides {
  const out = {} as Record<AgentOverrideField, unknown>
  for (const field of AGENT_OVERRIDE_FIELDS) out[field] = source[field]
  return out as AgentOverrides
}

/** An override record with nothing set, used by the create form. */
export function emptyAgentOverrides(): AgentOverrides {
  return pickAgentOverrides({})
}

/** Number of fields that override their default — shown on the collapsed area. */
export function countAgentOverrides(overrides: AgentOverrides): number {
  return AGENT_OVERRIDE_FIELDS.filter((field) => overrides[field] !== undefined).length
}
