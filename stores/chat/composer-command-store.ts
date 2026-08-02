"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import { pushRecent, toggleInList } from "@cognia/primitives"

/**
 * Per-user memory for the composer's slash-command picker: which commands were
 * used recently (MRU) and which are pinned. Both are plain arrays of command
 * NAMES (e.g. `git/commit`) — never the command objects — so a renamed or
 * removed command simply stops resolving at render time without corrupting the
 * persisted list. Mirrors the persist setup of `stores/ui/ui-store.ts`.
 */

/** How many recently-used commands to remember. */
export const RECENT_LIMIT = 6

interface ComposerCommandState {
  /** Most-recently-used command names, newest first, capped at RECENT_LIMIT. */
  recentCommands: string[]
  /** Pinned command names, in pin order (newest pin last). */
  pinnedCommands: string[]
  /**
   * {@link memoryTargetKey} of the last `#` capture destination, so a bare
   * `#note` + Enter can repeat it instead of forcing a popover pick every time.
   * Stored as the KEY, not the object, so an unrecognised persisted value
   * degrades to "ask again" via `parseMemoryTargetKey`.
   */
  lastMemoryTargetKey: string | null
  /** Record a command as just-used (dedupe-prepend, cap at RECENT_LIMIT). */
  noteCommandUsed: (name: string) => void
  /** Toggle a command's pinned state. */
  togglePin: (name: string) => void
  /** Remember the destination of the most recent `#` capture. */
  noteMemoryTargetUsed: (key: string) => void
}

export const useComposerCommandStore = create<ComposerCommandState>()(
  persist(
    (set) => ({
      recentCommands: [],
      pinnedCommands: [],
      lastMemoryTargetKey: null,
      noteMemoryTargetUsed: (key) => set(() => (key ? { lastMemoryTargetKey: key } : {})),
      noteCommandUsed: (name) =>
        set((s) =>
          name ? { recentCommands: pushRecent(s.recentCommands, name, RECENT_LIMIT) } : s
        ),
      togglePin: (name) =>
        set((s) => (name ? { pinnedCommands: toggleInList(s.pinnedCommands, name) } : s)),
    }),
    {
      name: "cognia-composer-commands",
      storage: persistLocalStorage(),
      partialize: (s) => ({
        recentCommands: s.recentCommands,
        pinnedCommands: s.pinnedCommands,
        lastMemoryTargetKey: s.lastMemoryTargetKey,
      }),
    }
  )
)

/** Non-hook read of whether `name` is currently pinned (for event handlers). */
export function isCommandPinned(name: string): boolean {
  return useComposerCommandStore.getState().pinnedCommands.includes(name)
}
