"use client"

/**
 * Inputs of the effective chat preview (ADR-0236 §4, R5), read from the same
 * owners a turn reads: the agent row (through `resolveCharacterById`, so a
 * variant's overlay applies), the default system prompt, the instruction
 * loader, the workspace record, the mode's resolved prompt and the agent's
 * enabled Skills. The preview is for a new chat with the chosen agent, mode
 * and workspace; a session's own prompt is not part of it.
 */

import { useCallback, useEffect, useState } from "react"
import {
  BUILT_IN_AGENT_MODES,
  BUILT_IN_MODE_PROMPTS,
  MODE_PROMPT_PASSTHROUGH_VALUES,
} from "@/lib/agent/modes/built-ins"
import { resolveCharacterById } from "@/lib/db/characters"
import { listEnabledSkillsByIds } from "@/lib/db/skills"
import { renderHarnessSections } from "@/lib/harness/render"
import {
  composeEffectivePreview,
  type EffectivePreview,
  type EffectivePreviewInput,
} from "@/lib/prompts/effective-preview"
import { resolveActiveAgentMode } from "@/lib/agent/resolve-agent-mode"
import { resolvePromptAsync } from "@/lib/prompts/resolve"
import { isTauri } from "@/lib/tauri"
import { allRootPaths } from "@/lib/workspace/roots"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"

export interface EffectiveChatPreviewSelection {
  agentId: string | null
  modeId: string | null
  workspaceId: string | null
}

export type EffectiveChatPreviewState =
  | { status: "loading" }
  | { status: "ready"; preview: EffectivePreview }
  | { status: "error"; error: string }

export function useEffectiveChatPreview(selection: EffectiveChatPreviewSelection): {
  state: EffectiveChatPreviewState
  reload: () => void
} {
  const { agentId, modeId, workspaceId } = selection
  const [epoch, setEpoch] = useState(0)
  const [state, setState] = useState<EffectiveChatPreviewState>({ status: "loading" })
  const reload = useCallback(() => setEpoch((value) => value + 1), [])
  const settings = useSettingsStore((store) => store.settings)
  // Subscribed so an edited mode recomposes; the lookup itself goes through
  // `resolveActiveAgentMode`. Plugin records likewise, so a contributed mode
  // that arrives or leaves recomposes.
  const customModes = useCustomModeStore((store) => store.customModes)
  const plugins = usePluginStore((store) => store.plugins)
  const project = useProjectStore((store) =>
    workspaceId ? store.projects.find((candidate) => candidate.id === workspaceId) : undefined
  )

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<EffectivePreview> => {
      const character = agentId ? await resolveCharacterById(agentId) : undefined
      const roots = project ? allRootPaths(project) : []

      let instructions: EffectivePreviewInput["instructions"]
      if (character?.bareMode ?? settings?.bareMode) {
        instructions = { omitted: "bare-mode" }
      } else if (!isTauri()) {
        instructions = { omitted: "no-filesystem" }
      } else {
        try {
          const { loadProjectInstructions } = await import("@/lib/claude/instructions/load")
          const resolved = await loadProjectInstructions({
            cwd: roots[0],
            roots,
            config: character?.instructionsOverride ?? settings?.instructions,
          })
          instructions = { section: resolved.section }
        } catch {
          instructions = { omitted: "load-failed" }
        }
      }

      let mode: EffectivePreviewInput["mode"] = null
      const builtIn = modeId ? BUILT_IN_AGENT_MODES.find((entry) => entry.id === modeId) : undefined
      // The send path's own lookup: the user's modes, then enabled plugins'.
      const other = builtIn ? undefined : resolveActiveAgentMode(modeId)
      if (builtIn) {
        const def = BUILT_IN_MODE_PROMPTS.get(builtIn.id)
        const text = def
          ? (
              await resolvePromptAsync(def, {
                context: workspaceId ? { workspaceId } : {},
                values: MODE_PROMPT_PASSTHROUGH_VALUES,
              })
            ).text
          : (builtIn.systemPrompt ?? "")
        mode = { name: builtIn.name, text }
      } else if (other) {
        mode = { name: other.name, text: other.systemPrompt ?? "" }
      }

      const skillIds = character?.skillIds ?? []
      const skills =
        skillIds.length > 0
          ? (await listEnabledSkillsByIds(skillIds, { projectId: workspaceId })).map(
              (skill) => skill.name
            )
          : []

      return composeEffectivePreview({
        base: {
          characterPrompt: character?.systemPrompt,
          appDefault: settings?.defaultSystemPrompt,
        },
        ...(character ? { agentName: character.name } : {}),
        ...(character?.persona ? { persona: character.persona } : {}),
        harnessText: renderHarnessSections(character?.harness),
        instructions,
        workspace: project
          ? { name: project.name, customInstructions: project.customInstructions }
          : null,
        mode,
        skills,
      })
    }
    load()
      .then((preview) => {
        if (!cancelled) setState({ status: "ready", preview })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [agentId, modeId, workspaceId, project, settings, customModes, plugins, epoch])

  return { state, reload }
}
