import type { RecorderAvailability } from "@cognia/plugin-contract/lib/skills/recording/recorder-availability"
export type { RecorderAvailability } from "@cognia/plugin-contract/lib/skills/recording/recorder-availability"

const UNAVAILABLE: RecorderAvailability = { available: false, pluginId: null }

let current: RecorderAvailability = UNAVAILABLE
const listeners = new Set<() => void>()

export function setRecorderAvailability(next: RecorderAvailability): void {
  if (next.available === current.available && next.pluginId === current.pluginId) return
  current = next
  for (const listener of listeners) listener()
}

export function clearRecorderAvailability(): void {
  setRecorderAvailability(UNAVAILABLE)
}

/** Stable snapshot, so `useSyncExternalStore` does not loop. */
export function getRecorderAvailability(): RecorderAvailability {
  return current
}

export function subscribeRecorderAvailability(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam — the module is a singleton by design. */
export function __resetRecorderAvailabilityForTesting(): void {
  current = UNAVAILABLE
  listeners.clear()
}
