"use client"

/**
 * Workspace settings → Plugins section.
 *
 * Edits the team-level capability default pool — the bundle every teammate
 * inherits unless its own overlay says otherwise. Reuses the same selector
 * primitives as TeammateConfigDialog: NativeTools / Character / Subagent /
 * ExternalPreset section components, plus the existing ToolsSection for
 * mcpServerIds + skillIds.
 *
 * Persists to the store via `updateTeamCapabilities` on each patch — no
 * local "Save" button. Treat the team capability bundle as live config;
 * mistakes are easy to undo by toggling the relevant section back.
 */

import { useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { ToolsSection } from "@/components/settings/presets/editor-sections/tools-section"
import { NativeToolsSection } from "@/components/settings/presets/editor-sections/native-tools-section"
import { CharacterSection } from "@/components/settings/presets/editor-sections/character-section"
import { SubagentSection } from "@/components/settings/presets/editor-sections/subagent-section"
import { ExternalPresetSection } from "@/components/settings/presets/editor-sections/external-preset-section"
import {
  emptyEditorState,
  type PresetEditorState,
} from "@/components/settings/presets/preset-editor-state"
import { listSkills } from "@/lib/db/skills"
import { listMcpServers } from "@/lib/db/mcp-servers"
import type { AgentTeam, TeamCapabilityBundle } from "@/types/agent/agent-team"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

export interface PluginsSectionProps {
  team: AgentTeam
}

/**
 * Project the team-level `TeamCapabilityBundle` into the `PresetEditorState`
 * shape the section components consume. Only the capability fields populate
 * — identity / content / tools etc. stay empty since this surface is purely
 * capability-pool editing.
 */
function bundleToEditorState(bundle: TeamCapabilityBundle | undefined): PresetEditorState {
  const base = emptyEditorState()
  if (!bundle) return base
  return {
    ...base,
    mcpServerIds: bundle.mcpServerIds,
    skillIds: bundle.skillIds ?? [],
    nativeAnthropicToolIds: bundle.nativeAnthropicToolIds,
    characterPackId: bundle.characterPackIds?.[0],
    externalAgentPresetId: bundle.externalAgentPresetIds?.[0],
    subagentIds: bundle.subagentIds,
  }
}

/**
 * Re-extract the bundle from a patched editor-state slice. Empty arrays
 * become `undefined` so the persisted bundle stays minimal.
 */
function editorStateToBundle(state: PresetEditorState): TeamCapabilityBundle {
  return {
    mcpServerIds:
      state.mcpServerIds && state.mcpServerIds.length > 0 ? state.mcpServerIds : undefined,
    skillIds: state.skillIds.length > 0 ? state.skillIds : undefined,
    nativeAnthropicToolIds: state.nativeAnthropicToolIds,
    characterPackIds: state.characterPackId ? [state.characterPackId] : undefined,
    externalAgentPresetIds: state.externalAgentPresetId ? [state.externalAgentPresetId] : undefined,
    subagentIds: state.subagentIds,
  }
}

export function PluginsSection({ team }: PluginsSectionProps) {
  const t = useTranslations("agentTeamsWorkspace.settings.plugins")
  const updateTeamCapabilities = useAgentTeamStore((s) => s.updateTeamCapabilities)

  const skillsRaw = useLiveQuery(() => listSkills(), [])
  const mcpRaw = useLiveQuery(() => listMcpServers(), [])
  const skills = useMemo(() => skillsRaw ?? [], [skillsRaw])
  const mcpServers = useMemo(() => mcpRaw ?? [], [mcpRaw])

  const editorState = useMemo(
    () => bundleToEditorState(team.config.capabilities),
    [team.config.capabilities]
  )

  const handlePatch = useCallback(
    (patch: Partial<PresetEditorState>) => {
      const merged: PresetEditorState = { ...editorState, ...patch }
      const bundle = editorStateToBundle(merged)
      updateTeamCapabilities(team.id, bundle)
    },
    [editorState, team.id, updateTeamCapabilities]
  )

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("intro")}</p>
      <ToolsSection
        state={editorState}
        onPatch={handlePatch}
        skillsCatalog={skills}
        mcpCatalog={mcpServers}
        defaultOpen={false}
      />
      <NativeToolsSection state={editorState} onPatch={handlePatch} />
      <CharacterSection state={editorState} onPatch={handlePatch} />
      <SubagentSection state={editorState} onPatch={handlePatch} />
      <ExternalPresetSection state={editorState} onPatch={handlePatch} />
    </div>
  )
}
