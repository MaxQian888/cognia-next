/**
 * The session's cogset override (ADR-0209).
 *
 * When the active workspace binds a cogset and the user switches to another
 * one anyway, the switch is recorded here rather than on the workspace or as
 * the global choice: it lasts until the app restarts or the user changes
 * workspace, whichever comes first. Deliberately not persisted.
 */

import { create } from "zustand"

export interface CogsetSessionState {
  overrideCogsetId?: string
  setOverride: (cogsetId: string) => void
  clearOverride: () => void
}

export const useCogsetSessionStore = create<CogsetSessionState>((set) => ({
  overrideCogsetId: undefined,
  setOverride: (cogsetId) => set({ overrideCogsetId: cogsetId }),
  clearOverride: () => set({ overrideCogsetId: undefined }),
}))
