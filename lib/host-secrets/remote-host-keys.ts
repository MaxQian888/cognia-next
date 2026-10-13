/**
 * The providers the paired Host this app drives holds a sealed key for
 * (ADR-0224 A6), by id only.
 *
 * A phone keeps its provider keys to itself, and an owner device can seal a
 * key on its Host instead. A turn the phone sends to that Host can then name
 * the provider without a key of its own: the Host fills the key it holds
 * (`fill_host_provider_key`). This module is what lets the phone know which
 * providers that is, so its model picker lists them and its send resolves
 * their endpoint. No key ever reaches it.
 *
 * A leaf with no imports, because the model picker and the send resolver both
 * read it; `./remote-host-keys-follower` keeps it current.
 */

interface RemoteHostKeys {
  /** The `/pair` Host the ids were read from. */
  hostId: string
  providers: ReadonlySet<string>
}

const EMPTY: ReadonlySet<string> = new Set()

let state: RemoteHostKeys | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** The providers the driven Host holds a key for; empty when none is driven. */
export function remoteHostKeyedProviders(): ReadonlySet<string> {
  return state?.providers ?? EMPTY
}

/** Whether the driven Host holds a sealed key for `providerId`. */
export function isRemoteHostKeyedProvider(providerId: string): boolean {
  return remoteHostKeyedProviders().has(providerId)
}

/** The Host the current ids belong to, or null. */
export function remoteHostKeysHostId(): string | null {
  return state?.hostId ?? null
}

/** Record what `hostId` holds. A list equal to the current one notifies nobody. */
export function setRemoteHostKeyedProviders(hostId: string, providerIds: Iterable<string>): void {
  const providers = new Set([...providerIds].filter((id) => id.trim()))
  if (
    state?.hostId === hostId &&
    state.providers.size === providers.size &&
    [...providers].every((id) => state!.providers.has(id))
  ) {
    return
  }
  state = { hostId, providers }
  notify()
}

/** Forget the ids, e.g. when the app stops driving that Host. */
export function clearRemoteHostKeyedProviders(): void {
  if (!state) return
  state = null
  notify()
}

/** Follow changes; the returned function stops. */
export function subscribeRemoteHostKeyedProviders(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/**
 * `providers` with an entry for every provider the driven Host keys whose own
 * entry has no key, so a picker built from settings lists it. Such an entry is
 * enabled: the Host's key is what serves it, whatever this device's switch for
 * a provider it never had a key for says. Returns the input unchanged (same
 * object) when there is nothing to add.
 */
export function withRemoteHostKeyedProviders<
  T extends { apiKey?: string; apiKeys?: string[]; enabled?: boolean },
>(
  providers: Record<string, T> | undefined,
  keyed: ReadonlySet<string> = remoteHostKeyedProviders()
): Record<string, T> | undefined {
  if (keyed.size === 0) return providers
  let next: Record<string, T> | null = null
  for (const providerId of keyed) {
    const entry = providers?.[providerId]
    if (hasOwnKey(entry)) continue
    if (entry && entry.enabled !== false) continue
    next ??= { ...(providers ?? {}) }
    next[providerId] = { ...(entry ?? { providerId }), enabled: true } as unknown as T
  }
  return next ?? providers
}

/** Whether a settings entry carries a key of its own. */
export function hasOwnKey(entry: { apiKey?: string; apiKeys?: string[] } | undefined): boolean {
  return !!(entry?.apiKey?.trim() || entry?.apiKeys?.some((key) => key.trim()))
}

/** Asks a running follower to read again; see `refreshRemoteHostKeys`. */
export const REMOTE_HOST_KEYS_REFRESH_EVENT = "cognia:remote-host-keys-refresh"

/** Ask the follower to read the driven Host's list again, e.g. after a write. */
export function refreshRemoteHostKeys(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(REMOTE_HOST_KEYS_REFRESH_EVENT))
}

/** Test seam: drop the ids and every listener. */
export function resetRemoteHostKeysForTests(): void {
  state = null
  listeners.clear()
}
