import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"
import { initialState } from "./initial-state"
import { createCustomModeActionsSlice } from "./slices/actions.slice"
import type { CustomModeState } from "./types"

export const useCustomModeStore = create<CustomModeState>()(
  persist(
    (set, get) => ({
      ...initialState,
      ...createCustomModeActionsSlice(set, get),
    }),
    {
      name: "cognia-custom-modes",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        customModes: Object.fromEntries(
          Object.entries(state.customModes).map(([id, mode]) => [
            id,
            {
              ...mode,
              // Convert dates to strings for storage
              createdAt:
                mode.createdAt instanceof Date ? mode.createdAt.toISOString() : mode.createdAt,
              updatedAt:
                mode.updatedAt instanceof Date ? mode.updatedAt.toISOString() : mode.updatedAt,
              lastUsedAt:
                mode.lastUsedAt instanceof Date ? mode.lastUsedAt.toISOString() : mode.lastUsedAt,
            },
          ])
        ),
      }),
      onRehydrateStorage: () => (state) => {
        // Convert date strings back to Date objects
        if (state?.customModes) {
          for (const mode of Object.values(state.customModes)) {
            if (typeof mode.createdAt === "string") {
              mode.createdAt = new Date(mode.createdAt)
            }
            if (typeof mode.updatedAt === "string") {
              mode.updatedAt = new Date(mode.updatedAt)
            }
            if (typeof mode.lastUsedAt === "string") {
              mode.lastUsedAt = new Date(mode.lastUsedAt)
            }
          }
        }
      },
    }
  )
)
