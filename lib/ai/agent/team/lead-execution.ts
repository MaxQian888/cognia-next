/**
 * Shared execution configuration for the team lead's own LLM calls.
 *
 * The lead is not dispatched through `dispatchTeammate` — it never claims a
 * pool slot and never gets tools — so it misses the provider resolution every
 * teammate path already performs. Before this module the lead's `executeAgent`
 * call carried no provider inputs at all, and since `executeAgent` reads no
 * store, its resolver built zero candidates and threw
 * `No candidate providers were available.` on *every* invocation, in every
 * environment, regardless of what the user had configured.
 *
 * This module is the single place that decides what the lead runs on, so
 * planning and review can never drift onto different providers.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type { ProviderSettingsEntry, RichCustomProviderEntry } from "@/lib/ai/provider-consumption"
import type { AgentTeammate } from "@/types/agent/agent-team"

/**
 * The subset of `ExecuteAgentConfig` that selects a provider/model. Declared
 * separately (rather than importing `ExecuteAgentConfig`) so this module stays
 * free of the executor's module graph — it is imported by the runtime deps,
 * which several node-env suites load.
 */
export interface LeadExecutionConfig {
  provider?: string
  model?: string
  providerSettings?: Record<string, ProviderSettingsEntry>
  customProviders?: RichCustomProviderEntry[]
  defaultProvider?: string
}

/**
 * No provider is configured, so the lead has nothing to run on. Distinct from a
 * *resolution* failure (bad key, disabled provider), which `executeAgent`
 * already reports with a specific, actionable message of its own.
 */
export class LeadProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LeadProviderConfigurationError"
  }
}

export interface BuildLeadExecutionConfigInput {
  lead: Pick<AgentTeammate, "config">
  settings: AppSettings | null | undefined
}

/**
 * Resolve the provider/model inputs for a lead LLM call.
 *
 * Precedence is `lead.config` → application defaults. Note what is deliberately
 * absent: when the lead pins a provider but no model we send **no** model, so
 * that provider's own configured model applies. `executeAgent` resolves
 * `config.model ?? resolution.model`, so passing the app-wide default model
 * alongside a pinned provider would ship e.g. a Claude model id to OpenAI.
 */
export function buildLeadExecutionConfig(
  input: BuildLeadExecutionConfigInput
): LeadExecutionConfig {
  const { lead, settings } = input
  const providerSettings = settings?.providerSettings as
    Record<string, ProviderSettingsEntry> | undefined
  const customProviders = settings?.customProviders as RichCustomProviderEntry[] | undefined

  const hasConfiguredProvider =
    Object.keys(providerSettings ?? {}).length > 0 || (customProviders ?? []).length > 0
  if (!hasConfiguredProvider) {
    throw new LeadProviderConfigurationError(
      "The team lead has no AI provider to run on: no provider is configured. " +
        "Open Settings → Providers and configure one (or set an explicit provider " +
        "on the lead member), then start the run again."
    )
  }

  const provider = lead.config?.provider
  // Only inherit the app default model when the lead is actually running on the
  // app default provider — see the precedence note above.
  const inheritsDefaultProvider = !provider || provider === settings?.defaultProvider
  const model = lead.config?.model ?? (inheritsDefaultProvider ? settings?.defaultModel : undefined)

  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(providerSettings ? { providerSettings } : {}),
    ...(customProviders ? { customProviders } : {}),
    ...(settings?.defaultProvider ? { defaultProvider: settings.defaultProvider } : {}),
  }
}

/**
 * Read the live app settings. Dynamically imported so the settings store (and
 * its Dexie / Tauri-IPC module graph) stays out of the team runtime's static
 * imports, which several node-env suites load.
 */
export async function readAppSettings(): Promise<AppSettings | null> {
  const { useSettingsStore } = await import("@/stores/settings")
  return useSettingsStore.getState().settings ?? null
}
