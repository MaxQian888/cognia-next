// Anthropic login selection for an explicit official-provider switch.
// Credentials stay behind the existing vault/discovery transports.

export interface SubscriptionActivationResult {
  /** True when an Anthropic subscription account ended up active. */
  activated: boolean
  /**
   * How the credential was sourced: an account already in the vault, or a
   * local Claude Code CLI login adopted on the fly. Absent when activation
   * failed.
   */
  source?: "vault" | "adopted"
  /** "none-found" when neither the vault nor the local CLI had a login. */
  error?: string
}

/**
 * Make the Anthropic subscription the active credential for an official
 * (OAuth) Claude switch. Preference order:
 *   1. The vault's active Anthropic account (re-activated to refresh the
 *      in-process bearer), else the first vault account.
 *   2. The local Claude Code CLI login, adopted into the vault on the fly.
 * Dynamic imports keep the subscription module out of web bundles — this
 * path only runs under Tauri.
 */
export async function activateSubscriptionForSwitch(): Promise<SubscriptionActivationResult> {
  try {
    const { listAccounts, getActiveAccount, setActiveAccount } =
      await import("@/lib/subscription/core/transport")
    const accounts = await listAccounts("anthropic")
    if (accounts.length > 0) {
      const active = await getActiveAccount("anthropic")
      const target = accounts.find((a) => a.id === active.activeAccountId)?.id ?? accounts[0].id
      await setActiveAccount("anthropic", target)
      return { activated: true, source: "vault" }
    }
    const { discoverAnthropicAuth, adoptAndActivateDiscoveredAuth } =
      await import("@/lib/subscription/anthropic/discovery")
    const discovered = await discoverAnthropicAuth()
    if (discovered) {
      await adoptAndActivateDiscoveredAuth(discovered)
      return { activated: true, source: "adopted" }
    }
    return { activated: false, error: "none-found" }
  } catch (err) {
    return { activated: false, error: err instanceof Error ? err.message : String(err) }
  }
}
