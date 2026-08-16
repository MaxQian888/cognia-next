/**
 * Global-search provider registry (ADR-0129).
 *
 * Module-level and framework-free: built-ins register once at first use
 * (`providers/index.ts`), plugins register through the plugin API, the dialog
 * subscribes so a late-registered provider shows up on the next keystroke.
 */

import type { GlobalSearchKind, GlobalSearchProvider } from "./types"

const providers = new Map<string, GlobalSearchProvider>()
const listeners = new Set<() => void>()
let revision = 0

function notify(): void {
  revision += 1
  for (const listener of listeners) listener()
}

/** Register (or replace, by id) a provider. Returns the unregister function. */
export function registerGlobalSearchProvider(provider: GlobalSearchProvider): () => void {
  providers.set(provider.id, provider)
  notify()
  return () => unregisterGlobalSearchProvider(provider.id)
}

export function unregisterGlobalSearchProvider(id: string): void {
  if (providers.delete(id)) notify()
}

/** Every registered provider, in registration order. */
export function listGlobalSearchProviders(): GlobalSearchProvider[] {
  return [...providers.values()]
}

export function getGlobalSearchProvider(id: string): GlobalSearchProvider | undefined {
  return providers.get(id)
}

/** Providers whose kind is in `kinds`, in registration order. */
export function providersForKinds(kinds: readonly GlobalSearchKind[]): GlobalSearchProvider[] {
  const wanted = new Set(kinds)
  return listGlobalSearchProviders().filter((p) => wanted.has(p.kind))
}

/** Bumps whenever the set changes — a cheap `useSyncExternalStore` snapshot. */
export function getGlobalSearchRegistryRevision(): number {
  return revision
}

export function subscribeGlobalSearchProviders(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only. */
export function __resetGlobalSearchRegistryForTesting(): void {
  providers.clear()
  listeners.clear()
  revision = 0
}
