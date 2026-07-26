// Content-capture confirmation + persistence → pet events. Pending-state
// changes come from the tiny capture store; successful persistence comes from
// a content-free lifecycle seam, so no clipboard text, URL, image, fingerprint,
// or source-app data reaches the pet event bus.

import {
  subscribeCapturePersisted,
  type CapturePersistedEvent as CaptureManagerPersistedEvent,
} from "@/lib/capture/capture-manager"
import { useCaptureStore } from "@/stores/capture/capture-store"
import type { CaptureCandidate } from "@/types/capture"
import type { PetEmit } from "../pet-event-bus"

export type CapturePersistedEvent = CaptureManagerPersistedEvent

export interface CaptureSourceDeps {
  subscribePending?: (listener: () => void) => () => void
  getPending?: () => CaptureCandidate | null
  subscribePersisted?: (listener: (event: CapturePersistedEvent) => void) => () => void
}

function defaultSubscribePending(listener: () => void): () => void {
  return useCaptureStore.subscribe((state, previous) => {
    if (state.pending === previous.pending) return
    listener()
  })
}

export function createCaptureSource(deps: CaptureSourceDeps = {}): (emit: PetEmit) => () => void {
  const subscribePending = deps.subscribePending ?? defaultSubscribePending
  const getPending = deps.getPending ?? (() => useCaptureStore.getState().pending)
  const subscribePersisted = deps.subscribePersisted ?? subscribeCapturePersisted

  return (emit) => {
    let initialized = false
    let wasPending = false

    const syncPending = () => {
      const pending = getPending()
      const isPending = pending !== null

      if (!initialized) {
        initialized = true
        wasPending = isPending
        if (pending) {
          emit({
            source: "capture",
            kind: "waiting",
            xp: 0,
            meta: { captureKind: pending.kind, pending: true },
          })
        }
        return
      }

      if (isPending === wasPending) return
      wasPending = isPending
      emit(
        pending
          ? {
              source: "capture",
              kind: "waiting",
              xp: 0,
              meta: { captureKind: pending.kind, pending: true },
            }
          : {
              source: "capture",
              kind: "idle",
              xp: 0,
              meta: { pending: false },
            }
      )
    }

    const disposePending = subscribePending(syncPending)
    const disposePersisted = subscribePersisted((event) => {
      emit({
        source: "capture",
        kind: "success",
        xp: 1,
        meta: { captureId: event.captureId, captureKind: event.kind },
      })
    })
    syncPending()

    return () => {
      disposePending()
      disposePersisted()
    }
  }
}

export const wireCaptureSource = createCaptureSource()
