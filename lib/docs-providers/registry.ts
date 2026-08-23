/**
 * Remote document provider registry — one registration per provider.
 *
 * Module-level map, duplicate registration throws, test reset re-seeds the
 * built-ins. Same shape as `lib/chat/mentions/pick-registry.ts` and
 * `lib/plugin/registries/*`, deliberately: adding a third document source
 * should be a `registerDocsProvider` call, not an edit to the composer.
 *
 * Registration happens at module load in `./index`, so `docsProviderPrefixes()`
 * is correct synchronously — `components/chat/composer-trigger.ts` is a pure,
 * render-free module and cannot await anything. That is also why the built-ins
 * live there and not here: this module must stay importable by a provider
 * without a cycle.
 */

import { detectPlatform } from "@/lib/platform/detect"
import type { DocsProvider } from "./types"

const providers = new Map<string, DocsProvider>()

export function registerDocsProvider(provider: DocsProvider): void {
  if (providers.has(provider.id)) {
    throw new Error(`docs provider "${provider.id}" already registered`)
  }
  if (!provider.mentionPrefix.endsWith(":")) {
    throw new Error(
      `docs provider "${provider.id}" mentionPrefix must end with ":" (got "${provider.mentionPrefix}")`
    )
  }
  for (const other of providers.values()) {
    if (other.mentionPrefix === provider.mentionPrefix) {
      throw new Error(
        `docs provider "${provider.id}" claims mention prefix "${provider.mentionPrefix}" already used by "${other.id}"`
      )
    }
  }
  providers.set(provider.id, provider)
}

/** Remove one dynamically contributed provider. Built-ins are never removed in production. */
export function unregisterDocsProvider(id: string): boolean {
  return providers.delete(id)
}

export function getDocsProvider(id: string): DocsProvider | undefined {
  return providers.get(id)
}

/** Every registered provider, in registration order. */
export function listDocsProviders(): DocsProvider[] {
  return [...providers.values()]
}

/**
 * Providers that can actually run on this host. The picker and the settings
 * cards both key off this — everything else stays visible but inert, so a
 * mobile user sees WHY the feature is missing instead of an empty list.
 */
export function listAvailableDocsProviders(): DocsProvider[] {
  const platform = detectPlatform()
  return listDocsProviders().filter((p) => p.hosts.includes(platform))
}

/** True when `provider` can run on this host. */
export function isDocsProviderHostSupported(provider: DocsProvider): boolean {
  return provider.hosts.includes(detectPlatform())
}

/**
 * `{ prefix, providerId }` for every registered provider — consumed by
 * `detectTrigger` to turn `@lark:` into a typed trigger. Returned for ALL
 * providers, not just host-supported ones: the trigger must still fire on an
 * unsupported host so the panel can explain itself.
 */
export function docsProviderPrefixes(): { prefix: string; providerId: string }[] {
  return listDocsProviders().map((p) => ({ prefix: p.mentionPrefix, providerId: p.id }))
}

/** Resolve the provider owning a namespace prefix (`"lark:"`). */
export function getDocsProviderByPrefix(prefix: string): DocsProvider | undefined {
  return listDocsProviders().find((p) => p.mentionPrefix === prefix)
}

/**
 * Test-only: drop every registration.
 *
 * Prefer `__resetDocsProvidersForTests` from `./index`, which also re-seeds the
 * built-ins; this bare clear is for suites that register only stubs.
 */
export function __clearDocsProvidersForTests(): void {
  providers.clear()
}
