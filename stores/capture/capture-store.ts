/**
 * Transient capture store — holds the single pending {@link CaptureCandidate}
 * awaiting user confirmation. Not persisted (ephemeral UI state); the confirmed
 * item is written to Dexie by the capture manager.
 */

import { create } from "zustand"
import type { CaptureCandidate } from "@/types/capture"

interface CaptureStoreState {
  pending: CaptureCandidate | null
  /** Show the confirm bubble for a candidate (replaces any prior pending one). */
  request: (candidate: CaptureCandidate) => void
  /** Clear the pending candidate (confirm/dismiss/timeout). */
  clear: () => void
}

export const useCaptureStore = create<CaptureStoreState>((set) => ({
  pending: null,
  request: (pending) => set({ pending }),
  clear: () => set({ pending: null }),
}))
