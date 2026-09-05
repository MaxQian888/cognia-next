/**
 * Provider registry. Module-level map, duplicate ids replace (a plugin that
 * reloads re-registers), test reset clears. Same shape as
 * `lib/issues/sources/registry.ts` and `lib/issues/run/registry.ts`.
 */

import type { IssueSyncProvider } from "./types"

export class IssueSyncRegistry {
  private readonly providers = new Map<string, IssueSyncProvider>()

  register(provider: IssueSyncProvider): () => void {
    this.providers.set(provider.id, provider)
    return () => {
      if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id)
    }
  }

  unregister(id: string): void {
    this.providers.delete(id)
  }

  get(id: string): IssueSyncProvider | undefined {
    return this.providers.get(id)
  }

  list(): IssueSyncProvider[] {
    return [...this.providers.values()]
  }
}

let singleton: IssueSyncRegistry | null = null

export function getIssueSyncRegistry(): IssueSyncRegistry {
  if (!singleton) singleton = new IssueSyncRegistry()
  return singleton
}

export function resetIssueSyncRegistry(): void {
  singleton = null
}

export function registerIssueSyncProvider(
  provider: IssueSyncProvider,
  registry: IssueSyncRegistry = getIssueSyncRegistry()
): () => void {
  return registry.register(provider)
}
