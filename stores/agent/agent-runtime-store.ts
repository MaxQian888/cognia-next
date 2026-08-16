"use client"

/**
 * Agent runtime selector — picks which engine drives the next chat turn.
 *
 * cognia-next ships with a Claude SDK sidecar as the default agent runtime.
 * The migrated External Agent layer adds a peer runtime that spawns a CLI
 * process (Codex, Claude Code CLI, Gemini CLI, Cursor, custom) over stdio.
 *
 * Since ADR-0117 a "mode" is no longer one flat id. It is a composition of
 * five axes (preset, permission, tool presentation, orchestration, runtime),
 * and — importantly — it belongs to a SESSION rather than to the app. This
 * store therefore holds two different things:
 *
 *   - `defaultComposition`: what a NEW session starts from.
 *   - `sessionCompositions`: what each live session actually selected.
 *
 * The distinction is the fix for a real defect: with a single global `modeId`,
 * changing the mode in one session silently retargeted every other session,
 * including one mid-turn.
 *
 * `modeId` / `setModeId` remain as a compatibility adapter. They are the public
 * surface for everything not yet migrated (`use-apply-preset`, the scheduler,
 * prompt presets), and they read and write the default composition's preset.
 *
 * Persisted to localStorage so the user's last choice survives reload.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import type { AgentCompositionSelectionV1 } from "@cognia/agent-config-types/agent-composition"
import { STANDARD_PRESET_ID } from "@/lib/agent/composition/preset-catalog"
import { appPresetIds } from "@/lib/agent/composition/app-preset-catalog"
import { selectionFromLegacyModeId } from "@/lib/agent/composition/legacy-mode-mapping"

export type AgentRuntime = "claude-sdk" | "external"

interface AgentRuntimeState {
  runtime: AgentRuntime
  /**
   * Legacy flat mode id.
   *
   * Kept in sync with `defaultComposition.presetId` so an unmigrated reader
   * never sees a stale value. Do not add new readers — use
   * `defaultComposition` / `compositionForSession`.
   */
  modeId: string
  defaultComposition: AgentCompositionSelectionV1
  sessionCompositions: Record<string, AgentCompositionSelectionV1>
  externalAgentId: string | null

  setRuntime: (runtime: AgentRuntime) => void
  setModeId: (modeId: string) => void
  setDefaultComposition: (selection: AgentCompositionSelectionV1) => void
  setSessionComposition: (sessionId: string, selection: AgentCompositionSelectionV1) => void
  clearSessionComposition: (sessionId: string) => void
  setExternalAgentId: (id: string | null) => void
}

/**
 * Map a flat mode id onto a composition selection.
 *
 * The known set is the FULL app catalog — built-ins plus the user's custom modes
 * plus enabled plugin modes. Using the built-in catalog alone made every custom
 * mode look like an unrecognised legacy id, so selecting one in the composer
 * silently stored `presetId: "standard"` while the send path still applied the
 * custom prompt: the picker, the settings sheet and the recorded composition all
 * disagreed with each other.
 */
function selectionFromModeId(modeId: string | null | undefined): AgentCompositionSelectionV1 {
  return selectionFromLegacyModeId(modeId, appPresetIds()).selection
}

/**
 * The v1 → v2 variant, which must not read another store.
 *
 * `migrate` runs while this store rehydrates, and the custom-mode store's own
 * rehydration is not ordered against it — asking it for ids here could return
 * an empty set and permanently degrade a v1 user's custom mode to Standard on
 * the one upgrade that gets to write the field.
 *
 * So treat the persisted id as known. Axis-only ids (`general`/`plan`/`build`/
 * `workflow`) still become axis overlays because `selectionFromLegacyModeId`
 * checks those first. A genuinely stale id survives into `presetId` and is
 * caught at *use* time by `resolveComposition`, which emits `unknown-preset`
 * and falls back visibly — strictly better than discarding the id silently and
 * irreversibly here.
 */
function migratedSelectionFromModeId(
  modeId: string | null | undefined
): AgentCompositionSelectionV1 {
  const trimmed = typeof modeId === "string" ? modeId.trim() : ""
  return selectionFromLegacyModeId(modeId, new Set(trimmed ? [trimmed] : [])).selection
}

export const useAgentRuntimeStore = create<AgentRuntimeState>()(
  persist(
    (set) => ({
      runtime: "claude-sdk",
      modeId: "general",
      defaultComposition: { presetId: STANDARD_PRESET_ID },
      sessionCompositions: {},
      externalAgentId: null,

      setRuntime: (runtime) => set({ runtime }),
      setModeId: (modeId) => set({ modeId, defaultComposition: selectionFromModeId(modeId) }),
      setDefaultComposition: (selection) =>
        // Mirror back onto `modeId` so unmigrated readers stay consistent
        // instead of drifting into a stale mode.
        //
        // `legacyModeId` first, because the mapping is not symmetric: an axis
        // id like `plan` becomes `{presetId: "standard", authority: "plan"}`,
        // and mirroring `presetId` alone would answer `standard` for a
        // composition that is still Plan. Unmigrated readers act on that —
        // `resolveActiveAgentMode` has no `standard` record and returns
        // undefined — so the round-trip silently dropped plan-mode behaviour on
        // the legacy send path. `legacyModeId` exists precisely so this
        // direction is lossless.
        set({
          defaultComposition: selection,
          modeId: selection.legacyModeId ?? selection.presetId,
        }),
      setSessionComposition: (sessionId, selection) =>
        set((state) => ({
          sessionCompositions: { ...state.sessionCompositions, [sessionId]: selection },
        })),
      clearSessionComposition: (sessionId) =>
        set((state) => {
          if (!Object.hasOwn(state.sessionCompositions, sessionId)) return state
          const next = { ...state.sessionCompositions }
          delete next[sessionId]
          return { sessionCompositions: next }
        }),
      setExternalAgentId: (externalAgentId) => set({ externalAgentId }),
    }),
    {
      name: "cognia-next.agent-runtime",
      storage: persistLocalStorage(),
      version: 2,
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<AgentRuntimeState>
        if (version >= 2) return state as AgentRuntimeState

        // v1 → v2: derive the default composition from the single global mode
        // id. Sessions get nothing, which is correct — v1 never recorded a
        // per-session choice, so inventing one would be fabricating history.
        return {
          ...state,
          defaultComposition: migratedSelectionFromModeId(state.modeId),
          sessionCompositions: {},
        } as AgentRuntimeState
      },
    }
  )
)

/**
 * The composition a session should run under.
 *
 * Falls back to the app default for a session that never chose one, which is
 * every session created before this shipped.
 */
export function compositionForSession(sessionId: string | undefined): AgentCompositionSelectionV1 {
  const state = useAgentRuntimeStore.getState()
  if (sessionId && Object.hasOwn(state.sessionCompositions, sessionId)) {
    return state.sessionCompositions[sessionId]
  }
  return state.defaultComposition
}
