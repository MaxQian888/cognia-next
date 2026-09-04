"use client"

/**
 * The one seam every entry point uses to reach the Update Center.
 *
 * The tray, the global search, the launch reminder, the About card and the
 * mobile Me page all route through here, so there is exactly one answer to
 * "where do updates live" and adding a sixth entry point does not mean
 * teaching it about settings deep links.
 */

export interface OpenUpdateCenterOptions {
  /** Scroll to and highlight one row, keyed `${kind}:${assetId}`. */
  focusKey?: string
  /** Open the character pack diff dialog for this character row. */
  packDiffCharacterId?: string
}

export type UpdateCenterOpenListener = (options: OpenUpdateCenterOptions) => void

const listeners = new Set<UpdateCenterOpenListener>()
let pending: OpenUpdateCenterOptions | null = null

/**
 * Ask the shell to show the Update Center.
 *
 * Two things happen, and both are needed. The settings shell is asked to
 * navigate to the Updates section, because a caller from the tray or a toast
 * may have nothing mounted at all. Then any mounted Update Center is told
 * which row to highlight. When nothing is listening yet (a tray click during
 * boot) the request is held and replayed to the first listener that arrives,
 * so the click is not silently dropped.
 */
export function openUpdateCenter(options: OpenUpdateCenterOptions = {}): void {
  navigateToUpdates()
  if (listeners.size === 0) {
    pending = options
    return
  }
  for (const listener of listeners) listener(options)
}

function navigateToUpdates(): void {
  if (typeof window === "undefined") return
  // Imported lazily so this seam stays usable from non-React callers and from
  // tests that never mount a store.
  void import("@/stores/ui/ui-store")
    .then((m) => m.useUIStore.getState().requestOpenSettings("updates"))
    .catch(() => {
      // A shell without the settings surface (the pet overlay window) simply
      // has nowhere to navigate. The listener path still runs.
    })
}

export function subscribeUpdateCenterOpen(listener: UpdateCenterOpenListener): () => void {
  listeners.add(listener)
  if (pending) {
    const replay = pending
    pending = null
    listener(replay)
  }
  return () => listeners.delete(listener)
}

/** Test-only: drop any held request. */
export function __resetUpdateCenterOpen(): void {
  listeners.clear()
  pending = null
}
