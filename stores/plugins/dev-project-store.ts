"use client"

/**
 * Remembers the plugin project directory a developer is working on, so the
 * DevTools "cognia CLI" launcher can run `cognia plugin build / dev / lint`
 * against it across sessions without re-picking the folder every time.
 *
 * Distinct from the transient directory picked by the "Load unpacked" flow
 * (`dialogs/load-unpacked-button.tsx`), which is held in component state and
 * cleared after install. This one persists.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"

export interface DevProjectState {
  /** Absolute path to the current plugin project dir, or null if unset. */
  projectDir: string | null
  /** Manifest name of the project at `projectDir`, for display. */
  projectName: string | null
  setProject: (dir: string, name?: string | null) => void
  clearProject: () => void
}

export const useDevProjectStore = create<DevProjectState>()(
  persist(
    (set) => ({
      projectDir: null,
      projectName: null,
      setProject: (dir, name = null) => set({ projectDir: dir, projectName: name }),
      clearProject: () => set({ projectDir: null, projectName: null }),
    }),
    { name: "cognia-plugin-dev-project", storage: persistLocalStorage() }
  )
)
