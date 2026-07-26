// Unified Control Center attention → pet events. The attention store already
// combines chat approvals, team HITL gates, and external-agent permission/input
// waits, so the pet observes that one projection instead of subscribing to the
// same upstream stores again.
//
// Only zero/non-zero edges emit: adding more pending items while the pet is
// already waiting stays silent, which avoids duplicate reactions during bursts.
// Stale journal entries are excluded because their underlying waiter is gone.

import { getAttentionSnapshot, subscribeAttention } from "@/lib/attention/attention-store"
import type { AttentionItem } from "@/lib/attention/types"
import type { PetEmit } from "../pet-event-bus"

export interface AttentionSourceDeps {
  subscribe?: (listener: () => void) => () => void
  getSnapshot?: () => readonly AttentionItem[]
}

export function createAttentionSource(
  deps: AttentionSourceDeps = {}
): (emit: PetEmit) => () => void {
  const subscribe = deps.subscribe ?? subscribeAttention
  const getSnapshot = deps.getSnapshot ?? getAttentionSnapshot

  return (emit) => {
    let initialized = false
    let active = false

    const sync = () => {
      const pendingCount = getSnapshot().filter((item) => !item.stale).length
      const nextActive = pendingCount > 0

      if (!initialized) {
        initialized = true
        active = nextActive
        if (active) {
          emit({
            source: "attention",
            kind: "waiting",
            xp: 0,
            meta: { pendingCount },
          })
        }
        return
      }

      if (nextActive === active) return
      active = nextActive
      emit({
        source: "attention",
        kind: active ? "waiting" : "review",
        xp: 0,
        meta: { pendingCount },
      })
    }

    const dispose = subscribe(sync)
    // Injectable subscribers are not required to synchronously publish their
    // first snapshot, so always seed the current edge explicitly.
    sync()
    return dispose
  }
}

export const wireAttentionSource = createAttentionSource()
