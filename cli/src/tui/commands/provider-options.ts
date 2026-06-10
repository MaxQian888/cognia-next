/**
 * Build the `/provider` switcher's option list: every known provider plus any
 * the user has configured, the active one first, each annotated with its auth
 * status so the picker shows at a glance which providers are usable. Pure.
 */
import { providerAuthMode } from "./builtins"
import type { ResolvedConfig } from "../../config/schema"

/**
 * Providers the CLI knows how to route (built-in dispatch + the env-key map in
 * `config/load.ts`). Custom/self-hosted ids configured by the user are appended.
 */
export const KNOWN_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "mistral",
  "cohere",
  "groq",
  "deepseek",
  "openrouter",
  // Subscription-based agents (reuse the shared `PROVIDERS` catalog + the
  // `authToken` credential): the OpenCode Zen / Go plans authenticate with a
  // subscription token rather than a metered key.
  "opencode",
  "opencode-go",
] as const

export interface ProviderOption {
  id: string
  /** Whether the provider has a stored credential (api key or subscription). */
  configured: boolean
  /** "subscription" | "api key" | "no credential". */
  auth: string
}

export function collectProviderOptions(config: ResolvedConfig): ProviderOption[] {
  const ids: string[] = []
  const add = (id: string) => {
    if (id && !ids.includes(id)) ids.push(id)
  }
  // Active provider first, then configured providers, then the known catalog.
  add(config.provider)
  for (const id of Object.keys(config.providers)) add(id)
  for (const id of KNOWN_PROVIDERS) add(id)
  return ids.map((id) => {
    const p = config.providers[id]
    return {
      id,
      configured: Boolean(p?.apiKey || p?.authToken),
      auth: providerAuthMode(config, id),
    }
  })
}
