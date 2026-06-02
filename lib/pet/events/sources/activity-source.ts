// Generic "busy ⇄ idle" source adapter. Many subsystems expose a store whose
// snapshot tells us whether work is in flight (terminal commands, agent-team
// runs). This helper diffs that boolean across notifications and emits an
// "active" event on the rising edge and a "complete" event on the falling edge.
// Pure with respect to its injected `subscribe`/`isActiveNow`, so it tests with
// plain fakes.

import type { PetEventKind, PetEventSource } from "@/types/pet"
import type { PetEmit } from "../pet-event-bus"

export interface ActivitySourceOptions {
  /** Register a change listener; returns an unsubscribe. */
  subscribe: (listener: () => void) => () => void
  /** Snapshot: is the subsystem actively working right now? */
  isActiveNow: () => boolean
  source: PetEventSource
  /** Event emitted on the rising edge (idle → active). */
  activeKind: PetEventKind
  /** Event emitted on the falling edge (active → idle). Default "success". */
  idleKind?: PetEventKind
  /** XP awarded on completion. */
  xpOnComplete?: number
  emit: PetEmit
}

export function wireActivitySource(options: ActivitySourceOptions): () => void {
  let active = options.isActiveNow()
  return options.subscribe(() => {
    const now = options.isActiveNow()
    if (now === active) return
    active = now
    if (now) {
      options.emit({ source: options.source, kind: options.activeKind })
    } else {
      options.emit({
        source: options.source,
        kind: options.idleKind ?? "success",
        xp: options.xpOnComplete ?? 0,
      })
    }
  })
}
