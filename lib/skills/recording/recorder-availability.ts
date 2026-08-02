/**
 * Whether the recorder is available, published by the plugin that owns it.
 *
 * `cognia-skill-recorder` is the permission owner — its manifest declares the
 * three native grants — so disabling it must disable recording everywhere: the
 * Skills toolbar button, the command-palette item, `/record-skill`, and the
 * `skills.record` shortcut.
 *
 * A tiny registry rather than a direct import in each entry point, because the
 * dependency has to run the other way: entry points must not reach into plugin
 * internals, and the plugin must not know which surfaces exist. `activate`
 * publishes, `deactivate` clears, everyone else subscribes.
 *
 * Off-desktop the plugin is `runtimeCompatibility.browser: blocked`, so
 * `activate` never runs and this stays empty — which is correct, but is a
 * *different* reason from "the user turned it off". Callers distinguish the two
 * with `isTauri()` so the copy can say the right thing.
 */

export interface RecorderAvailability {
  available: boolean
  pluginId: string | null
}

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
