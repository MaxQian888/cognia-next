/**
 * Plugin Subscription API — **read-only** access to the unified
 * subscription state (plan summaries + Anthropic usage metrics) for
 * usage-dashboard / cost-guard / quota plugins.
 *
 * SAFETY: this surface never exposes credentials. Specifically:
 *  - `getActiveAccountId` / `getActiveAccountSummary` return only the
 *    credential-free `AccountSummary` (id/label/plan/email/timestamps);
 *    the active snapshot's `env` array (which carries the resolved OAuth
 *    bearer for spawn) is dropped at the boundary.
 *  - usage snapshots have their `rawHeaders` (which can contain sensitive
 *    rate-limit / auth headers) and the internal Dexie `localId` stripped.
 *
 * There is no write surface — accounts/credentials are managed only through
 * the Settings UI. Gated by `subscription:read`.
 */

import { listAccounts, getActiveAccount } from "@/lib/subscription/core/transport"
import { getDb } from "@/lib/db/schema"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type {
  AccountSummary,
  ProviderId,
  SubscriptionUsageRow,
  UsageSnapshot,
} from "@/lib/subscription/core/types"

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

const PROVIDERS: readonly ProviderId[] = ["anthropic", "codex", "opencode"] as const

/** Drop the sensitive `rawHeaders` + internal `localId` from a usage row. */
function sanitizeUsage(row: SubscriptionUsageRow | UsageSnapshot): PluginUsageSnapshot {
  const { rawHeaders: _rawHeaders, ...rest } = row as SubscriptionUsageRow
  delete (rest as { localId?: number }).localId
  return rest
}

/**
 * Create the read-only Subscription API for a plugin. Every method is
 * gated by `subscription:read`.
 */
export function createSubscriptionAPI(pluginId: string): PluginSubscriptionAPI {
  const api: PluginSubscriptionAPI = {
    providers: () => PROVIDERS,
    listAccounts: (provider) => listAccounts(provider),
    getActiveAccountId: async (provider) => {
      // Strip the snapshot's `env` (OAuth bearer) — only the id leaves.
      const snapshot = await getActiveAccount(provider)
      return snapshot.activeAccountId ?? null
    },
    getActiveAccountSummary: async (provider) => {
      const snapshot = await getActiveAccount(provider)
      if (!snapshot.activeAccountId) return null
      const accounts = await listAccounts(provider)
      return accounts.find((a) => a.id === snapshot.activeAccountId) ?? null
    },
    getUsage: async (limit = 200) => {
      const rows = await getDb()
        .subscriptionUsage.orderBy("fetchedAt")
        .reverse()
        .limit(limit)
        .toArray()
      return rows.map(sanitizeUsage)
    },
    getLatestUsage: async () => {
      const rows = await getDb().subscriptionUsage.orderBy("fetchedAt").reverse().limit(1).toArray()
      return rows.length > 0 ? sanitizeUsage(rows[0]) : null
    },
    onUsageUpdate: (handler) => {
      const table = getDb().subscriptionUsage
      const onCreate = (_pk: unknown, row: SubscriptionUsageRow) => {
        try {
          handler(sanitizeUsage(row))
        } catch {
          // A throwing plugin handler must not break the Dexie write.
        }
      }
      table.hook("creating", onCreate)
      return () => table.hook("creating").unsubscribe(onCreate)
    },
  }

  return createGuardedAPI(pluginId, api, {
    providers: "subscription:read",
    listAccounts: "subscription:read",
    getActiveAccountId: "subscription:read",
    getActiveAccountSummary: "subscription:read",
    getUsage: "subscription:read",
    getLatestUsage: "subscription:read",
    onUsageUpdate: "subscription:read",
  })
}
