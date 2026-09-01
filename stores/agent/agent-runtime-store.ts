"use client"

/**
 * Agent runtime selector, which picks the engine that drives the next chat turn.
 *
 * The choice is one `AgentRuntimeRef` (see `lib/ai/agent/runtime-catalog`):
 * Cognia's own runtime in the bundled sidecar, a locally configured external
 * agent process (Codex, Claude Code CLI, Gemini CLI, Cursor, custom), or a
 * configuration the paired host owns. It used to be three separate persisted
 * fields that could disagree, and the flat fields survive here only as
 * deprecated mirrors for readers that have not migrated.
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
import { BUILTIN_RUNTIME_REF, type AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"

/**
 * @deprecated Compatibility mirror of {@link AgentRuntimeState.runtimeRef}.
 * The lane is now an `AgentRuntimeRef`, which also names the target, so a
 * "which agent" answer can no longer go missing from a "which lane" answer.
 * Readers still on this field are being migrated.
 */
export type AgentRuntime = "claude-sdk" | "external"

/** What the composer remembers about a host-owned agent it has selected. */
export interface ExternalHostConfigSelection {
  configId: string
  revision: string
  lifecycleGeneration: number
  /** Label only. Never sent — the host runs what its own store holds. */
  name: string
}

interface AgentRuntimeState {
  /**
   * What runs the next turn: Cognia's own runtime, a locally configured
   * external agent, or a configuration the paired host owns.
   *
   * This replaced three separately persisted fields (`runtime`,
   * `externalAgentId`, `externalHostConfig`) that could describe a lane with no
   * target, which is a state no turn can be sent from. One value makes that
   * unrepresentable, and it is why the composer chip no longer needs repair
   * effects to reconcile a disagreement.
   */
  runtimeRef: AgentRuntimeRef
  /** @deprecated Mirror of `runtimeRef.kind`. Written only by `setRuntimeRef`. */
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
  /** @deprecated Mirror of a `kind: "external"` ref. Written only by `setRuntimeRef`. */
  externalAgentId: string | null
  /**
   * @deprecated Mirror of a `kind: "host"` ref. Written only by `setRuntimeRef`.
   *
   * A configuration owned by the paired HOST, when the external lane points at
   * one instead of at a locally configured agent.
   *
   * Kept beside `externalAgentId` rather than folded into it because the two
   * are addressed differently and only one can be right: a local id names an
   * agent in this browser's store, while a host selection has to carry the
   * revision and readiness generation the run will be admitted against. They
   * are mutually exclusive by construction — setting either clears the other —
   * so nothing downstream has to decide which one wins.
   *
   * The `name` is a cached label for the chip; it is never sent anywhere. The
   * host resolves what actually runs from the stamp.
   */
  externalHostConfig: ExternalHostConfigSelection | null

  /** The single writer for the lane. Every mirror above is derived from it. */
  setRuntimeRef: (ref: AgentRuntimeRef) => void
  setModeId: (modeId: string) => void
  setDefaultComposition: (selection: AgentCompositionSelectionV1) => void
  setSessionComposition: (sessionId: string, selection: AgentCompositionSelectionV1) => void
  clearSessionComposition: (sessionId: string) => void
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

/**
 * The deprecated flat fields, recomputed from the ref.
 *
 * They are written on every ref change rather than left to drift, so a reader
 * that has not migrated yet still sees the truth, and a downgrade to a build
 * that only knows the flat fields still opens on the right lane.
 */
function legacyMirrors(ref: AgentRuntimeRef): {
  runtime: AgentRuntime
  externalAgentId: string | null
  externalHostConfig: ExternalHostConfigSelection | null
} {
  switch (ref.kind) {
    case "builtin":
      return { runtime: "claude-sdk", externalAgentId: null, externalHostConfig: null }
    case "external":
      return { runtime: "external", externalAgentId: ref.agentId, externalHostConfig: null }
    case "host":
      return {
        runtime: "external",
        externalAgentId: null,
        externalHostConfig: {
          configId: ref.configId,
          revision: ref.revision,
          lifecycleGeneration: ref.lifecycleGeneration,
          name: ref.name ?? ref.configId,
        },
      }
  }
}

/**
 * Read a v2 state's three fields as one ref.
 *
 * A host selection wins over a local one because v2's setters cleared the other
 * key on write, so both being set can only mean a partially applied write, and
 * the host stamp is the more specific of the two.
 *
 * `runtime: "external"` with neither target set was representable in v2 and
 * could not send a turn. It migrates to the default lane rather than being
 * preserved: carrying a dead state forward would only reproduce the chip's
 * "External (none selected)" dead end on the other side of the migration.
 */
function refFromLegacyFields(state: Partial<AgentRuntimeState>): AgentRuntimeRef {
  if (state.runtime !== "external") return BUILTIN_RUNTIME_REF
  const host = state.externalHostConfig
  if (host?.configId) {
    return {
      kind: "host",
      configId: host.configId,
      revision: host.revision,
      lifecycleGeneration: host.lifecycleGeneration,
      ...(host.name ? { name: host.name } : {}),
    }
  }
  if (state.externalAgentId) return { kind: "external", agentId: state.externalAgentId }
  return BUILTIN_RUNTIME_REF
}

export const useAgentRuntimeStore = create<AgentRuntimeState>()(
  persist(
    (set) => ({
      runtimeRef: BUILTIN_RUNTIME_REF,
      runtime: "claude-sdk",
      modeId: "general",
      defaultComposition: { presetId: STANDARD_PRESET_ID },
      sessionCompositions: {},
      externalAgentId: null,
      externalHostConfig: null,

      setRuntimeRef: (runtimeRef) => set({ runtimeRef, ...legacyMirrors(runtimeRef) }),
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
    }),
    {
      name: "cognia-next.agent-runtime",
      storage: persistLocalStorage(),
      version: 3,
      migrate: (persisted, version) => {
        let state = (persisted ?? {}) as Partial<AgentRuntimeState>

        // v1 to v2: derive the default composition from the single global mode
        // id. Sessions get nothing, which is correct, because v1 never recorded
        // a per-session choice and inventing one would fabricate history.
        if (version < 2) {
          state = {
            ...state,
            defaultComposition: migratedSelectionFromModeId(state.modeId),
            sessionCompositions: {},
          }
        }

        // v2 to v3: fold the three lane fields into one ref.
        if (version < 3) {
          const runtimeRef = refFromLegacyFields(state)
          state = { ...state, runtimeRef, ...legacyMirrors(runtimeRef) }
        }

        return state as AgentRuntimeState
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
