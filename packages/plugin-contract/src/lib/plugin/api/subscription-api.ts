/**
 * The plugin contract's share of `lib/plugin/api/subscription-api.ts`, which re-exports these.
 */
import type { AccountSummary, ProviderId, UsageSnapshot } from "../../../types/subscription/index"

/** Usage snapshot with sensitive raw headers + internal key stripped. */
export type PluginUsageSnapshot = Omit<UsageSnapshot, "rawHeaders">

export interface PluginSubscriptionAPI {
  /** Provider ids the host supports. */
  providers(): readonly ProviderId[]
  /** Credential-free account summaries for a provider. */
  listAccounts(provider: ProviderId): Promise<AccountSummary[]>
  /** Active account id for a provider, or `null`. Never returns env/tokens. */
  getActiveAccountId(provider: ProviderId): Promise<string | null>
  /** Summary of the active account for a provider (plan/email), or `null`. */
  getActiveAccountSummary(provider: ProviderId): Promise<AccountSummary | null>
  /** Recent Anthropic usage snapshots (newest first), headers stripped. */
  getUsage(limit?: number): Promise<PluginUsageSnapshot[]>
  /** The most recent usage snapshot, or `null`. */
  getLatestUsage(): Promise<PluginUsageSnapshot | null>
  /** Subscribe to new usage samples. Returns a disposer. */
  onUsageUpdate(handler: (snapshot: PluginUsageSnapshot) => void): () => void
}
