import { LOCAL_PROVIDER_URLS, type LocalProviderName } from "@cognia/provider-types/local-provider"
import { PROVIDERS } from "@cognia/provider-types/provider"
import { getProviderRequirements } from "@cognia/provider-core/providers/completeness"

/**
 * The built-in provider catalog, projected down to what the first-run sign-in
 * step needs to render one row and validate one draft.
 *
 * **Why the whole catalog and not a shortlist.** The three subscription cards
 * cover Anthropic, ChatGPT and OpenCode; everyone else — OpenAI, Google, a
 * self-hosted Ollama, DeepSeek, an Anthropic-compatible endpoint like Kimi or
 * GLM — had no first-run path at all and had to find Settings → Providers
 * unaided. A curated shortlist would drift out of step with the catalog the
 * moment a provider is added, and "the one I pay for is missing" is the same
 * dead end in a nicer shape.
 *
 * The requirement flags come from `getProviderRequirements`, the same rules
 * Settings validates against, so a draft this step accepts is one that page
 * would call configured.
 */
export type OnboardingProviderCategory =
  "flagship" | "local" | "aggregator" | "specialized" | "enterprise"

export interface OnboardingProviderOption {
  id: string
  name: string
  category: OnboardingProviderCategory
  /** Needs an API key. False for local servers. */
  requiresCredential: boolean
  /** Needs a base URL the catalog cannot supply. */
  requiresBaseUrl: boolean
  isLocal: boolean
  /** Prefill for local servers — the well-known localhost port. */
  defaultBaseUrl?: string
  /** Where the user gets a key, when the catalog knows. */
  dashboardUrl?: string
  placeholderApiKey?: string
}

export interface OnboardingProviderGroup {
  category: OnboardingProviderCategory
  options: OnboardingProviderOption[]
}

/**
 * Flagships first, then local — a deliberate choice that is easy to miss in a
 * list of 77 and the only one that needs no account anywhere. The long tails
 * follow.
 */
const CATEGORY_ORDER: readonly OnboardingProviderCategory[] = [
  "flagship",
  "local",
  "aggregator",
  "specialized",
  "enterprise",
]

function toOption(id: string): OnboardingProviderOption {
  const config = PROVIDERS[id]
  const requirements = getProviderRequirements(id)
  const category = (config?.category ?? "specialized") as OnboardingProviderCategory
  return {
    id,
    name: config?.name ?? id,
    // `local` is a catalog category *and* a requirement flag; trust the flag,
    // so a provider the adapter calls local is grouped with its peers even if
    // the catalog entry forgot the label.
    category: requirements.isLocal ? "local" : category,
    requiresCredential: requirements.requiresCredential,
    requiresBaseUrl: requirements.requiresBaseUrl,
    isLocal: requirements.isLocal,
    defaultBaseUrl: requirements.isLocal
      ? LOCAL_PROVIDER_URLS[id as LocalProviderName]
      : config?.defaultBaseURL,
    dashboardUrl: config?.dashboardUrl,
    placeholderApiKey: config?.placeholderApiKey,
  }
}

export function listOnboardingProviders(): OnboardingProviderOption[] {
  return Object.keys(PROVIDERS).map(toOption)
}

export function onboardingProviderOption(id: string): OnboardingProviderOption | undefined {
  return PROVIDERS[id] ? toOption(id) : undefined
}

/** Ordered groups, each alphabetised. Empty categories are dropped. */
export function groupOnboardingProviders(
  options: readonly OnboardingProviderOption[] = listOnboardingProviders()
): OnboardingProviderGroup[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    options: options
      .filter((option) => option.category === category)
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((group) => group.options.length > 0)
}

/** What the form starts with for a provider — the local default, or blank. */
export function initialProviderDraft(option: OnboardingProviderOption): {
  apiKey: string
  baseURL: string
} {
  return { apiKey: "", baseURL: option.defaultBaseUrl ?? "" }
}
