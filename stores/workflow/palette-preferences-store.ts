// Zustand store for the workflow editor's node-palette preferences:
// starred ("favorite") node kinds and a most-recently-used list. Mirrors
// `workflow-library-store`: both lists persist to localStorage via
// `partialize`. Entries are stored by node-kind STRING (not catalog entry
// reference) so the palette can resolve them lazily through
// `nodeCatalogEntry()` and tolerate a kind that disappears when a plugin is
// uninstalled.

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import { pushRecent, toggleInList } from "@cognia/primitives"

/** How many recently-used kinds to keep. */
export const RECENT_LIMIT = 8

interface PalettePreferencesState {
  favoriteNodeKinds: string[]
  recentlyUsedNodeKinds: string[]
  toggleFavorite: (kind: string) => void
  isFavorite: (kind: string) => boolean
  recordUsed: (kind: string) => void
}

export const usePalettePreferencesStore = create<PalettePreferencesState>()(
  persist(
    (set, get) => ({
      favoriteNodeKinds: [],
      recentlyUsedNodeKinds: [],

      toggleFavorite: (kind) =>
        set((s) => ({ favoriteNodeKinds: toggleInList(s.favoriteNodeKinds, kind) })),

      isFavorite: (kind) => get().favoriteNodeKinds.includes(kind),

      recordUsed: (kind) =>
        set((s) => ({
          recentlyUsedNodeKinds: pushRecent(s.recentlyUsedNodeKinds, kind, RECENT_LIMIT),
        })),
    }),
    {
      name: "workflow-palette-prefs",
      version: 1,
      storage: persistLocalStorage(),
      partialize: (s) => ({
        favoriteNodeKinds: s.favoriteNodeKinds,
        recentlyUsedNodeKinds: s.recentlyUsedNodeKinds,
      }),
    }
  )
)
