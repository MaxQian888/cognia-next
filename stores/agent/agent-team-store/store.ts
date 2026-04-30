import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"
import { initialState } from "./initial-state"
import { createAgentTeamActionsSlice } from "./slices/actions.slice"
import type { AgentTeamState } from "./types"

/**
 * Persisted-state version. Bump (and add a `migrate` branch below) whenever
 * the persisted shape changes incompatibly. Kept in lockstep with the
 * pattern used by `external-agent-store/store.ts`.
 */
const PERSIST_VERSION = 1

export const useAgentTeamStore = create<AgentTeamState>()(
  persist(
    (set, get) => ({
      ...initialState,
      ...createAgentTeamActionsSlice(set, get),
    }),
    {
      name: "cognia-agent-teams",
      storage: createJSONStorage(() => localStorage),
      version: PERSIST_VERSION,
      partialize: (state) => ({
        templates: state.templates,
        defaultConfig: state.defaultConfig,
        displayMode: state.displayMode,
        workspaceTab: state.workspaceTab,
      }),
      migrate: (persistedState, _version) => {
        // Identity migration baseline. Future schema changes should branch
        // on `_version` and transform `persistedState` accordingly.
        return persistedState as AgentTeamState
      },
    }
  )
)

export default useAgentTeamStore
