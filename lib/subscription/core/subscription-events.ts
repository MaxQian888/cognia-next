// Lightweight renderer-side notifier for "the active subscription credential
// changed" (a new account was activated, signed out, or the boot rebuild
// pushed the OAuth bearer into ApiKeyState).
//
// Deliberately separate from `change-tracker.ts`, which exists to schedule
// debounced WebDAV uploads. This bus is about *UI reactivity*: the chat header
// (and any other surface that mirrors auth state) subscribes so it can re-read
// `claude_has_oauth_bearer` / the active plan the moment the credential lands,
// instead of latching a stale "No API key" badge until something else happens
// to re-run the check.
//
// Import-light (no Tauri / store dependency) so it can be called from the
// transport layer without risking an import cycle.

type Listener = () => void

const listeners = new Set<Listener>()

/**
 * Subscribe to subscription-credential changes. Returns an unsubscribe fn.
 * The callback receives no arguments — consumers re-read whatever they need.
 */
export function subscribeSubscriptionChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Notify every subscriber that the active subscription credential changed.
 * One throwing listener must never starve the others, so each call is guarded.
 */
export function notifySubscriptionChanged(): void {
  // Snapshot first: a listener may (un)subscribe during dispatch.
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A consumer's re-check failing is not this bus's problem.
    }
  }
}

/** Test-only: drop every subscriber so suites don't leak across cases. */
export function __resetSubscriptionEventsForTesting(): void {
  listeners.clear()
}
