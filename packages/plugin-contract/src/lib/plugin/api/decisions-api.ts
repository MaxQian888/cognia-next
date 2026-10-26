/**
 * The plugin contract's share of `lib/plugin/api/decisions-api.ts`, which re-exports these.
 */
import type {
  DecisionProviderInfo,
  DecisionRequest,
  DecisionResult,
} from "../../../types/decisions/index"
import type {
  PluginDecisionProviderInput,
  PluginDecisionRegistration,
} from "../../../types/plugin/plugin-decisions"

export interface PluginDecisionsAPI {
  /**
   * Answer typed questions through the user's selected provider (or an
   * explicit installed one). Never throws for provider problems — the result
   * carries a typed error instead. Requires `decisions:run`.
   */
  decide(
    request: DecisionRequest,
    options?: { providerId?: string; signal?: AbortSignal }
  ): Promise<DecisionResult>
  /** Every installed provider, as plain data. */
  listProviders(): DecisionProviderInfo[]
  /** The provider selected in settings, or `null` when none is. */
  getSelectedProviderId(): Promise<string | null>
  /** Add a provider as `<pluginId>:<id>`. Requires `decisions:provide`. */
  registerProvider(provider: PluginDecisionProviderInput): PluginDecisionRegistration
  /** Prefixed ids of the providers this plugin registered. */
  listRegistered(): string[]
}
