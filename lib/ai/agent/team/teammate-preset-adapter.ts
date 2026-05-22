/**
 * Bi-directional adapter between `TeammateConfig` and `PresetEditorState`.
 *
 * The `<PresetEditor>` component already knows how to edit:
 *   identity (name / description / icon / color / category)
 *   capability (model / permissionMode / effort / agentModeId)
 *   tools (allowedTools / disallowedTools / mcpServerIds / skillIds)
 *   advanced (workingDir / isDefault / isFavorite)
 *
 * `TeammateConfig` carries a subset:
 *   model / temperature / systemPrompt / tools / specialization / runtime
 *   + a `capabilities` overlay (mcp / skill / native-tool / character /
 *     external-agent-preset / subagent / a2ui id lists, each with
 *     add/remove/replace semantics).
 *
 * This adapter projects between the two so the same editor surface can
 * host TeammateConfig editing. The mapping is deliberately lossy where
 * the two shapes don't overlap — the converter records the lossy fields
 * (specialization / runtime / temperature) as `metadata` on the editor
 * state so the wrapper can render them in its own `extraSections`.
 */

import type {
  AgentTeam,
  AgentTeammate,
  CapabilityListOverlay,
  TeammateCapabilityOverlay,
  TeammateConfig,
} from "@/types/agent/agent-team"
import {
  emptyEditorState,
  type PresetEditorState,
} from "@/components/settings/presets/preset-editor-state"

/**
 * Capability overlay → flat id list used by the existing
 * `<ToolsSection>` skill / mcp pickers, which treat the list as the
 * teammate's effective subset to expose. We project the overlay's
 * `replace` first (it short-circuits) → otherwise team default ∪ add
 * minus remove. When `team` is omitted we fall back to the overlay's
 * add-only view because the editor doesn't have a baseline to merge with.
 */
function overlayToFlatList(
  team: TeammateConfig["capabilities"] extends infer O ? O : never,
  overlay: CapabilityListOverlay | undefined,
  fallbackBase: ReadonlyArray<string> | undefined
): string[] | undefined {
  // The `team` parameter is the team-level capability default list for the
  // same key (e.g. `team.config.capabilities.skillIds`). The editor displays
  // the effective set the teammate sees at runtime so users grok the merge
  // semantics directly.
  void team
  if (overlay?.replace !== undefined) {
    return [...overlay.replace]
  }
  const base = fallbackBase ?? []
  const removeSet = overlay?.remove ? new Set(overlay.remove) : null
  const filtered = removeSet ? base.filter((id) => !removeSet.has(id)) : base
  const merged = overlay?.add ? [...filtered, ...overlay.add] : filtered
  if (merged.length === 0 && !overlay) return undefined
  // Dedupe preserving first-occurrence order.
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of merged) {
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/**
 * Convert a `TeammateConfig` (with optional surrounding team for the
 * capability baseline) into a `PresetEditorState` consumable by
 * `<PresetEditor>`.
 *
 * Fields mapped:
 *   - systemPrompt → content
 *   - model → model
 *   - tools (allow/deny) → allowedTools / disallowedTools
 *   - capabilities.mcpServerIds → mcpServerIds
 *   - capabilities.skillIds → skillIds
 *   - capabilities.nativeAnthropicToolIds → nativeAnthropicToolIds
 *   - capabilities.characterPackIds (first) → characterPackId
 *   - capabilities.externalAgentPresetIds (first) → externalAgentPresetId
 *   - capabilities.subagentIds → subagentIds
 *
 * Fields kept on `AgentTeammate` (not in editor state):
 *   - name / description / role / specialization
 *   - config.runtime / config.temperature / config.requirePlanApproval /
 *     config.maxSteps / config.timeout
 *
 * Callers wrapping `<PresetEditor>` (TeammateConfigDialog) render those
 * extra fields themselves in `extraSections`.
 */
export function teammateToPresetState(
  teammate: Pick<AgentTeammate, "name" | "description" | "config">,
  team?: Pick<AgentTeam, "config">
): PresetEditorState {
  const base = emptyEditorState()
  const config = teammate.config
  const overlay: TeammateCapabilityOverlay = config.capabilities ?? {}
  const teamBundle = team?.config.capabilities ?? {}

  // Tools — split TeammateConfig.tools into allow/deny based on `!` prefix
  // (consistent with how the workflow editor distinguishes negative
  // patterns; if no `!` prefix is used, treat everything as allowed).
  const allowedTools: string[] = []
  const disallowedTools: string[] = []
  for (const t of config.tools ?? []) {
    if (t.startsWith("!")) disallowedTools.push(t.slice(1))
    else allowedTools.push(t)
  }

  return {
    ...base,
    name: teammate.name,
    description: teammate.description,
    content: config.systemPrompt ?? "",
    model: config.model ?? "",
    allowedTools,
    disallowedTools,
    mcpServerIds: overlayToFlatList(undefined, overlay.mcpServerIds, teamBundle.mcpServerIds),
    skillIds: overlayToFlatList(undefined, overlay.skillIds, teamBundle.skillIds) ?? [],
    nativeAnthropicToolIds: overlayToFlatList(
      undefined,
      overlay.nativeAnthropicToolIds,
      teamBundle.nativeAnthropicToolIds
    ),
    characterPackId: overlayToFlatList(
      undefined,
      overlay.characterPackIds,
      teamBundle.characterPackIds
    )?.[0],
    externalAgentPresetId: overlayToFlatList(
      undefined,
      overlay.externalAgentPresetIds,
      teamBundle.externalAgentPresetIds
    )?.[0],
    subagentIds: overlayToFlatList(undefined, overlay.subagentIds, teamBundle.subagentIds),
  }
}

/**
 * Diff a flat id list against a base list and produce a minimal overlay.
 * Returns `undefined` when the lists are identical (no override needed).
 */
function diffListToOverlay(
  flat: ReadonlyArray<string> | undefined,
  base: ReadonlyArray<string> | undefined
): CapabilityListOverlay | undefined {
  if (flat === undefined) return undefined
  const flatSet = new Set(flat)
  const baseList = base ?? []
  const baseSet = new Set(baseList)

  const add: string[] = []
  for (const id of flat) {
    if (!baseSet.has(id)) add.push(id)
  }
  const remove: string[] = []
  for (const id of baseList) {
    if (!flatSet.has(id)) remove.push(id)
  }
  if (add.length === 0 && remove.length === 0) return undefined
  const overlay: CapabilityListOverlay = {}
  if (add.length > 0) overlay.add = add
  if (remove.length > 0) overlay.remove = remove
  return overlay
}

/**
 * Convert a saved `PresetEditorState` back into a `TeammateConfig`. Uses the
 * team's default capability bundle (when known) to compute the minimal
 * overlay rather than persisting the full effective list — that keeps the
 * team default the source of truth and lets ops centralised changes
 * propagate automatically.
 */
export function presetStateToTeammateConfig(
  state: PresetEditorState,
  previous: TeammateConfig,
  team?: Pick<AgentTeam, "config">
): TeammateConfig {
  const teamBundle = team?.config.capabilities ?? {}

  // Tools — re-encode the deny list as `!`-prefixed entries.
  const tools: string[] = [...state.allowedTools, ...state.disallowedTools.map((t) => `!${t}`)]

  // Capabilities — diff each list against the team default to produce a
  // minimal `add/remove` overlay. Lists identical to the team default fall
  // back to undefined so they inherit cleanly.
  const overlay: TeammateCapabilityOverlay = {}
  const mcp = diffListToOverlay(state.mcpServerIds, teamBundle.mcpServerIds)
  if (mcp) overlay.mcpServerIds = mcp
  const skills = diffListToOverlay(state.skillIds, teamBundle.skillIds)
  if (skills) overlay.skillIds = skills
  const native = diffListToOverlay(state.nativeAnthropicToolIds, teamBundle.nativeAnthropicToolIds)
  if (native) overlay.nativeAnthropicToolIds = native
  const characterList = state.characterPackId ? [state.characterPackId] : []
  const character = diffListToOverlay(characterList, teamBundle.characterPackIds)
  if (character) overlay.characterPackIds = character
  const externalList = state.externalAgentPresetId ? [state.externalAgentPresetId] : []
  const external = diffListToOverlay(externalList, teamBundle.externalAgentPresetIds)
  if (external) overlay.externalAgentPresetIds = external
  const subagents = diffListToOverlay(state.subagentIds, teamBundle.subagentIds)
  if (subagents) overlay.subagentIds = subagents

  const next: TeammateConfig = {
    ...previous,
    systemPrompt: state.content.trim() || undefined,
    model: state.model.trim() || undefined,
    tools: tools.length > 0 ? tools : undefined,
  }
  if (Object.keys(overlay).length > 0) {
    next.capabilities = overlay
  } else {
    delete next.capabilities
  }
  return next
}
