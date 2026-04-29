import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"
import { initialState } from "./initial-state"
import { createAgentTeamActionsSlice } from "./slices/actions.slice"
import type { AgentTeamState } from "./types"

export const useAgentTeamStore = create<AgentTeamState>()(
  persist(
    (set, get) => ({
      ...initialState,
      ...createAgentTeamActionsSlice(set, get),
    }),
    {
      name: "cognia-agent-teams",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        templates: state.templates,
        defaultConfig: state.defaultConfig,
        displayMode: state.displayMode,
        workspaceTab: state.workspaceTab,
      }),
    }
  )
)

export default useAgentTeamStore
