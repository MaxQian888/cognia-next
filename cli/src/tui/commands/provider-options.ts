/**
 * Build the `/provider` switcher's option list: every provider in the shared
 * desktop catalog plus any the user has configured, the active one first, each
 * annotated with its display name + auth status so the picker shows at a glance
 * which providers exist and which are usable. Pure.
 *
 * The catalog is the single source of truth shared with the GUI
 * (`@cognia/provider-types`), so the CLI no longer drifts behind a hand-kept
 * subset — when the app gains a provider, `/provider` lists it too.
 */
import { PROVIDERS } from "@cognia/provider-types/provider"

import { providerAuthMode } from "./builtins"
import type { ResolvedConfig } from "../../config/schema"

/**
 * Curated display order for the providers the CLI most commonly routes (built-in
 * dispatch + the env-key map in `config/load.ts`). These lead the picker; every
 * other catalog provider is appended after them in catalog order. Custom/
 * self-hosted ids the user configured are surfaced ahead of the catalog.
 */
const PREFERRED_ORDER = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "mistral",
  "cohere",
  "groq",
  "openrouter",
  // Subscription-based agents (reuse the shared `PROVIDERS` catalog + the
  // `authToken` credential): the OpenCode Zen / Go plans authenticate with a
  // subscription token rather than a metered key.
  "opencode",
  "opencode-go",
] as const

/**
 * Every provider the CLI can switch to: the curated front-runners first, then
 * the rest of the shared catalog. Derived from `PROVIDERS` so it stays in lock-
 * step with the GUI instead of being a hand-maintained subset.
 */
export const KNOWN_PROVIDERS: readonly string[] = (() => {
  const ordered: string[] = []
  const add = (id: string) => {
    if (id && PROVIDERS[id] && !ordered.includes(id)) ordered.push(id)
  }
  for (const id of PREFERRED_ORDER) add(id)
  for (const id of Object.keys(PROVIDERS)) add(id)
  return ordered
})()

export interface ProviderOption {
  id: string
  /** Human-readable provider name from the shared catalog (falls back to id). */
  name: string
  /** Whether the provider has a stored credential (api key or subscription). */
  configured: boolean
  /** "subscription" | "api key" | "no credential". */
  auth: string
  /**
   * Whether this provider authenticates with a metered API key (catalog
   * `apiKeyRequired`). Drives the picker's "prompt for a key" affordance: a
   * key-required provider with no credential opens the inline key prompt on
   * select, while key-less providers (local runtimes, OAuth/subscription) just
   * switch. Unknown/custom ids default to `true` — they need *some* credential.
   */
  requiresKey: boolean
  /** Where the user obtains a key (catalog dashboard/docs URL), when known. */
  keyUrl?: string
}

export function collectProviderOptions(config: ResolvedConfig): ProviderOption[] {
  const ids: string[] = []
  const add = (id: string) => {
    if (id && !ids.includes(id)) ids.push(id)
  }
  // Active provider first, then configured providers, then the shared catalog.
  add(config.provider)
  for (const id of Object.keys(config.providers)) add(id)
  for (const id of KNOWN_PROVIDERS) add(id)
  return ids.map((id) => {
    const p = config.providers[id]
    const cat = PROVIDERS[id]
    const keyUrl = cat?.dashboardUrl ?? cat?.docsUrl
    return {
      id,
      name: cat?.name ?? id,
      configured: Boolean(p?.apiKey || p?.authToken),
      auth: providerAuthMode(config, id),
      requiresKey: cat?.apiKeyRequired ?? true,
      ...(keyUrl ? { keyUrl } : {}),
    }
  })
}
