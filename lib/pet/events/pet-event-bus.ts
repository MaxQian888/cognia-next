// The PetEventBus — a tiny singleton emitter that decouples the pet from every
// subsystem that feeds it. Subsystems never import pet internals; thin adapters
// (`./sources/*`) translate native lifecycles into `PetEvent`s and call
// `emitPetEvent`. Listeners run synchronously and must not throw (errors are
// swallowed so one bad listener can't break the others). Mirrors the observer
// shape of `lib/connectors/bus.ts`.

import type { PetEvent } from "@/types/pet"

export type PetEventListener = (event: PetEvent) => void

/** What source adapters call to emit — `at` is filled in if omitted. */
export type PetEmit = (event: Omit<PetEvent, "at"> & { at?: number }) => void

export class PetEventBus {
  private listeners = new Set<PetEventListener>()

  subscribe(listener: PetEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: PetEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A misbehaving observer must never break the bus.
      }
    }
  }

  /** Test/teardown helper. */
  clear(): void {
    this.listeners.clear()
  }
}

let bus: PetEventBus | null = null

export function getPetEventBus(): PetEventBus {
  if (!bus) bus = new PetEventBus()
  return bus
}

/** Convenience emit that stamps `at` when the caller omits it. */
export function emitPetEvent(event: Omit<PetEvent, "at"> & { at?: number }): void {
  getPetEventBus().emit({ ...event, at: event.at ?? Date.now() })
}

/** Test helper to drop the singleton. */
export function __resetPetEventBusForTesting(): void {
  bus?.clear()
  bus = null
}
