// Thin transient store for the pet's runtime UI state. The canonical record
// (profile / needs / bindings / achievements) lives in Dexie and is read
// reactively via `useLiveQuery`; this store only holds ephemeral things the
// renderer needs frame-to-frame plus the persisted widget placement.
//
// Modeled on the persist+partialize pattern in
// `stores/agent/agent-team-store/store.ts`.

import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import type { PetOneShot, PetVisualState } from "@/types/pet"

export interface PetBubble {
  /** Rendered text (already localized). */
  text: string
  /** Source tag for styling/telemetry ("template" | "llm" | "system"). */
  origin: "template" | "llm" | "system"
}

export interface PetUiPosition {
  x: number
  y: number
}

interface PetStoreState {
  /** Current resting/loop visual state. */
  visualState: PetVisualState
  /** FIFO queue of one-shot animations to play (drained by the animation hook). */
  oneShotQueue: PetOneShot[]
  /** Currently displayed speech bubble, or null. */
  bubble: PetBubble | null
  /** Whether the widget is collapsed to a minimized handle. */
  minimized: boolean
  /** Drag-offset from the docked anchor (persisted so it survives reloads). */
  position: PetUiPosition | null

  setVisualState: (state: PetVisualState) => void
  enqueueOneShot: (shot: PetOneShot) => void
  dequeueOneShot: () => PetOneShot | null
  clearOneShots: () => void
  setBubble: (bubble: PetBubble | null) => void
  setMinimized: (minimized: boolean) => void
  setPosition: (position: PetUiPosition | null) => void
}

export const usePetStore = create<PetStoreState>()(
  persist(
    (set, get) => ({
      visualState: "idle",
      oneShotQueue: [],
      bubble: null,
      minimized: false,
      position: null,

      setVisualState: (visualState) => set({ visualState }),
      enqueueOneShot: (shot) => set((s) => ({ oneShotQueue: [...s.oneShotQueue, shot] })),
      dequeueOneShot: () => {
        const [head, ...rest] = get().oneShotQueue
        if (head === undefined) return null
        set({ oneShotQueue: rest })
        return head
      },
      clearOneShots: () => set({ oneShotQueue: [] }),
      setBubble: (bubble) => set({ bubble }),
      setMinimized: (minimized) => set({ minimized }),
      setPosition: (position) => set({ position }),
    }),
    {
      name: "cognia-pet-ui",
      storage: createJSONStorage(() => localStorage),
      // Only the widget placement is durable; visual/bubble/queue are ephemeral.
      partialize: (state) => ({ minimized: state.minimized, position: state.position }),
    }
  )
)
