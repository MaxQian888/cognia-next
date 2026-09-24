/**
 * Capability resolver — pure function that merges a team's default capability
 * bundle with a teammate's per-member overlay into a flat `ResolvedCapabilities`
 * record consumed by `lib/claude/build-options.ts` when assembling
 * `SendOptions` for a teammate dispatch.
 *
 * Overlay semantics (per `CapabilityListOverlay`):
 *   - `replace`: short-circuit — final = replace (team default ignored).
 *   - else:     final = (team default ∖ remove) ∪ add
 *
 * Each field is independently overlaid. Undefined / missing fields fall
 * through to the team default unchanged. Duplicate ids are deduplicated
 * preserving first-occurrence order so the runtime sees a stable, minimal
 * id list per capability.
 *
 * This function is deliberately pure + sync — no registry lookups, no
 * persistence, no logging. Validation against live overlay registries is
 * the runtime's responsibility (e.g. the build-options pipeline silently
 * drops unknown ids; the settings UI surfaces missing-dep warnings).
 */

import type {
  AgentTeam,
  AgentTeammate,
  CapabilityListOverlay,
  ResolvedCapabilities,
  TeamCapabilityBundle,
  TeammateCapabilityOverlay,
} from "@/types/agent/agent-team"

/**
 * The 7 capability keys this resolver merges. Keeping them as a module-level
 * tuple lets the merge loop stay declarative without enumerating field names
 * in every helper.
 */
const CAPABILITY_KEYS = [
  "mcpServerIds",
  "skillIds",
  "nativeAnthropicToolIds",
  "characterPackIds",
  "externalAgentPresetIds",
  "subagentIds",
  "a2uiTemplateIds",
] as const

type CapabilityKey = (typeof CAPABILITY_KEYS)[number]

/** Dedupe preserving first-occurrence order. */
function dedupe(ids: ReadonlyArray<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/**
 * Apply a single `CapabilityListOverlay` against a team's default list.
 * `replace` wins; otherwise `(base ∖ remove) ∪ add` with dedup.
 */
function applyOverlay(
  base: ReadonlyArray<string> | undefined,
  overlay: CapabilityListOverlay | undefined
): string[] {
  if (overlay?.replace !== undefined) {
    return dedupe(overlay.replace)
  }
  const baseList = base ?? []
  const remove = overlay?.remove
  const add = overlay?.add
  if (!remove && !add) {
    return dedupe(baseList)
  }
  const removeSet = remove ? new Set(remove) : null
  const filtered = removeSet ? baseList.filter((id) => !removeSet.has(id)) : baseList
  if (!add || add.length === 0) {
    return dedupe(filtered)
  }
  return dedupe([...filtered, ...add])
}

/**
 * Resolve a teammate's effective capability set against its team's default
 * pool. Returns a fully-populated `ResolvedCapabilities` (no undefined
 * fields) so downstream consumers can iterate without null guards.
 */
export function resolveTeammateCapabilities(
  team: Pick<AgentTeam, "config">,
  teammate: Pick<AgentTeammate, "config">
): ResolvedCapabilities {
  const teamBundle: TeamCapabilityBundle = team.config.capabilities ?? {}
  const overlay: TeammateCapabilityOverlay = teammate.config.capabilities ?? {}

  // Fast path: both empty — return a fresh empty bundle. We avoid the
  // `EMPTY_RESOLVED_CAPABILITIES` sentinel here because callers commonly
  // mutate (push) the returned arrays; sharing the sentinel's nested
  // arrays would leak mutations across resolve calls.
  if (Object.keys(teamBundle).length === 0 && Object.keys(overlay).length === 0) {
    return {
      mcpServerIds: [],
      skillIds: [],
      nativeAnthropicToolIds: [],
      characterPackIds: [],
      externalAgentPresetIds: [],
      subagentIds: [],
      a2uiTemplateIds: [],
    }
  }

  const result: ResolvedCapabilities = {
    mcpServerIds: [],
    skillIds: [],
    nativeAnthropicToolIds: [],
    characterPackIds: [],
    externalAgentPresetIds: [],
    subagentIds: [],
    a2uiTemplateIds: [],
  }
  for (const key of CAPABILITY_KEYS) {
    result[key] = applyOverlay(teamBundle[key], overlay[key])
  }
  return result
}

/**
 * Resolve the team-level pool only (no teammate overlay). Used when emitting
 * `Plugins` settings UI and validating team-template `requires` blocks at
 * registration time, where individual teammates haven't been instantiated
 * yet.
 */
export function resolveTeamCapabilities(team: Pick<AgentTeam, "config">): ResolvedCapabilities {
  const teamBundle: TeamCapabilityBundle = team.config.capabilities ?? {}
  if (Object.keys(teamBundle).length === 0) {
    return {
      mcpServerIds: [],
      skillIds: [],
      nativeAnthropicToolIds: [],
      characterPackIds: [],
      externalAgentPresetIds: [],
      subagentIds: [],
      a2uiTemplateIds: [],
    }
  }
  return {
    mcpServerIds: dedupe(teamBundle.mcpServerIds ?? []),
    skillIds: dedupe(teamBundle.skillIds ?? []),
    nativeAnthropicToolIds: dedupe(teamBundle.nativeAnthropicToolIds ?? []),
    characterPackIds: dedupe(teamBundle.characterPackIds ?? []),
    externalAgentPresetIds: dedupe(teamBundle.externalAgentPresetIds ?? []),
    subagentIds: dedupe(teamBundle.subagentIds ?? []),
    a2uiTemplateIds: dedupe(teamBundle.a2uiTemplateIds ?? []),
  }
}

/**
 * ADR-0090 Phase 7: clamp a resolved capability bundle to what the FROZEN
 * execution spec's runtime can actually serve (intersection — compatibility
 * gating can only remove, never add). Id lists whose backing runtime
 * capability is absent from `effective` are emptied:
 *   - `mcp`              → `mcpServerIds`
 *   - `subagents.native` → `subagentIds`
 *   - `tools.ordinary`   → `nativeAnthropicToolIds` + `skillIds` (skills run on tools)
 * Prompt-level bundles (character packs, A2UI templates) and external presets
 * (they SELECT a different runtime rather than run on this one) pass through.
 */
export function clampCapabilitiesToRuntime(
  resolved: ResolvedCapabilities,
  effective: ReadonlyArray<string>
): ResolvedCapabilities {
  const has = new Set(effective)
  return {
    ...resolved,
    mcpServerIds: has.has("mcp") ? resolved.mcpServerIds : [],
    subagentIds: has.has("subagents.native") ? resolved.subagentIds : [],
    nativeAnthropicToolIds: has.has("tools.ordinary") ? resolved.nativeAnthropicToolIds : [],
    skillIds: has.has("tools.ordinary") ? resolved.skillIds : [],
  }
}

/** Re-export to give callers a single import site. */
export type {
  CapabilityListOverlay,
  ResolvedCapabilities,
  TeamCapabilityBundle,
  TeammateCapabilityOverlay,
} from "@/types/agent/agent-team"

/** Re-export the key tuple in case tests want to enumerate. */
export const RESOLVED_CAPABILITY_KEYS: ReadonlyArray<CapabilityKey> = CAPABILITY_KEYS
