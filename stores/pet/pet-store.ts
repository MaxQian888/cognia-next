// Thin transient store for the pet's runtime UI state. The canonical record
// (profile / needs / bindings / achievements) lives in Dexie and is read
// reactively via `useLiveQuery`; this store only holds ephemeral things the
// renderer needs frame-to-frame plus the persisted widget placement.
//
// Modeled on the persist+partialize pattern in
// `stores/agent/agent-team-store/store.ts`.

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import type { PetOneShot, PetStatKey, PetVisualState } from "@/types/pet"

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

/** Transient "the pet just became unwell" signal consumed by the care-alert hook. */
export interface PetCareAlert {
  /** Epoch ms of the transition (changes each episode → re-fires the hook). */
  at: number
  /** Pet name for the notification body, or null before hatch. */
  petName: string | null
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
  /** Stat keys that grew on the most recent event (drives the "grew" pulse). */
  lastGrewStats: PetStatKey[]
  /** Pending "became unwell" signal, or null. Set by the controller, drained
   *  by the care-alert hook which fires the gentle notification. */
  careAlert: PetCareAlert | null
  /** Per-interaction cooldown deadlines (event kind → epoch-ms "ready at").
   *  Transient UI gate so action buttons can't be spammed; never persisted. */
  actionCooldowns: Record<string, number>

  setVisualState: (state: PetVisualState) => void
  enqueueOneShot: (shot: PetOneShot) => void
  dequeueOneShot: () => PetOneShot | null
  clearOneShots: () => void
  setBubble: (bubble: PetBubble | null) => void
  setMinimized: (minimized: boolean) => void
  setPosition: (position: PetUiPosition | null) => void
  setLastGrewStats: (keys: PetStatKey[]) => void
  setCareAlert: (alert: PetCareAlert | null) => void
  /** Start a cooldown for an interaction kind, ready again at `until` (epoch ms). */
  setActionCooldown: (kind: string, until: number) => void
}

export const usePetStore = create<PetStoreState>()(
  persist(
    (set, get) => ({
      visualState: "idle",
      oneShotQueue: [],
      bubble: null,
      minimized: false,
      position: null,
      lastGrewStats: [],
      careAlert: null,
      actionCooldowns: {},

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
      setLastGrewStats: (lastGrewStats) => set({ lastGrewStats }),
      setCareAlert: (careAlert) => set({ careAlert }),
      setActionCooldown: (kind, until) =>
        set((s) => ({ actionCooldowns: { ...s.actionCooldowns, [kind]: until } })),
    }),
    {
      name: "cognia-pet-ui",
      storage: persistLocalStorage(),
      // Only the widget placement is durable; visual/bubble/queue are ephemeral.
      partialize: (state) => ({ minimized: state.minimized, position: state.position }),
    }
  )
)
