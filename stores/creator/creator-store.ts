"use client"

/**
 * Creator workbench state (ADR-0117, Phase 3).
 *
 * ADR-0117 says Creator "records progress in the existing workflow run event
 * log rather than a new store", and that still holds — this store deliberately
 * holds no step state. What lives here is the pair of things the run log cannot
 * own: the *grant* (which directory the user authorised, which must survive a
 * reload or the user re-picks it every time) and a *pointer* to the active run
 * (so a reload can reattach to the timeline instead of starting a second one).
 *
 * Progress, approvals and failures are read back from the log via
 * `readCreatorProgress`. Anything that both could hold belongs to the log.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import type { AuthoringRoot, CreatorArtifactKind } from "@/types/creator"
import { validateAuthoringRoot } from "@/lib/creator/authoring-root"
import type { AuthoringRootRejection } from "@/lib/creator/authoring-root"

export interface CreatorState {
  /** The granted authoring root, or null when the user has not chosen one. */
  authoringRoot: AuthoringRoot | null
  /** Run id of the active Creator session, or null when idle. */
  activeRunId: string | null
  artifactKind: CreatorArtifactKind
  /**
   * Capability additions the user approved, and the diff they were approved
   * for. Bound together so a regenerated, wider diff invalidates the approval
   * (see `approvalCoversDiff`).
   */
  approvedAdditions: string[]

  grantAuthoringRoot: (
    input: Parameters<typeof validateAuthoringRoot>[0]
  ) => { ok: true } | { ok: false; reason: AuthoringRootRejection }
  revokeAuthoringRoot: () => void
  setArtifactKind: (kind: CreatorArtifactKind) => void
  startRun: (runId: string) => void
  endRun: () => void
  approveAdditions: (capabilities: readonly string[]) => void
  clearApprovals: () => void
}

export const useCreatorStore = create<CreatorState>()(
  persist(
    (set) => ({
      authoringRoot: null,
      activeRunId: null,
      artifactKind: "plugin",
      approvedAdditions: [],

      grantAuthoringRoot: (input) => {
        const result = validateAuthoringRoot(input)
        if (!result.valid) return { ok: false, reason: result.reason }
        // A new root invalidates approvals: they were granted against an
        // artifact in the previous root and say nothing about this one.
        set({ authoringRoot: result.root, approvedAdditions: [] })
        return { ok: true }
      },

      revokeAuthoringRoot: () =>
        set({ authoringRoot: null, approvedAdditions: [], activeRunId: null }),

      setArtifactKind: (artifactKind) => set({ artifactKind }),

      startRun: (activeRunId) => set({ activeRunId, approvedAdditions: [] }),

      endRun: () => set({ activeRunId: null }),

      approveAdditions: (capabilities) =>
        set({ approvedAdditions: [...new Set(capabilities.map((c) => c.trim()))].sort() }),

      clearApprovals: () => set({ approvedAdditions: [] }),
    }),
    {
      name: "cognia-next.creator",
      version: 1,
      storage: persistLocalStorage(),
      // `activeRunId` is persisted so a reload reattaches; approvals are not
      // persisted across a browser restart, so a long-dormant tab cannot resume
      // straight into a write with a stale grant.
      partialize: (state) => ({
        authoringRoot: state.authoringRoot,
        activeRunId: state.activeRunId,
        artifactKind: state.artifactKind,
      }),
    }
  )
)
