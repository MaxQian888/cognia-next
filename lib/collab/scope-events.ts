/**
 * "The collaboration scope this profile works in just changed."
 *
 * Switching organization rewrites the profile's binding (`adoptOrganization`),
 * and every hook that resolved a `CurrentCollabContext` on mount is then
 * holding the old org. Reloading the window was the only way to notice. This
 * is the one signal those hooks subscribe to so they re-resolve instead: the
 * org switch publishes it, and nothing else needs to know who listens.
 *
 * In-process only. A second window learns about the switch through its own
 * refresh, which reads the binding afresh.
 */

const listeners = new Set<() => void>()

export function notifyCollabScopeChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // One broken subscriber must not keep the others on the old scope.
    }
  }
}

export function subscribeCollabScopeChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
