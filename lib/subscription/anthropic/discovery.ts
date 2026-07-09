// Frontend wrapper around the `anthropic_oauth_discover` Tauri command. Used
// by the "Reuse" mode of the Anthropic login dialog, the providers-tab
// one-click reuse card, and the CCSwitch official-provider switch path — all
// so an existing local Claude Code CLI subscription login can be adopted
// without re-running the PKCE flow.

import {
  anthropicOauthDiscover,
  anthropicOauthSavePkceResult,
  setActiveAccount,
  type DiscoveredAnthropicAuth,
} from "../core/transport"
import type { Account, AnthropicCredentialData } from "@/types/subscription"

export type { DiscoveredAnthropicAuth }

/**
 * Probe `~/.claude/.credentials.json` + Claude Code's keyring entry. Returns
 * `null` when no CLI subscription login is present anywhere; the rejected
 * case is reserved for actual parse failures (renderer surfaces as
 * "credential corrupted").
 *
 * E2E hook: under `NEXT_PUBLIC_E2E=1` the renderer may publish a synthetic
 * payload via `window.__cogniaE2EAnthropicDiscovery` to drive the adopt flow
 * without a real local login. Setting it to `null` exercises the "no
 * credential found" branch; leaving it `undefined` falls through to Rust.
 */
export async function discoverAnthropicAuth(): Promise<DiscoveredAnthropicAuth | null> {
  if (typeof window !== "undefined") {
    const w = window as { __cogniaE2EAnthropicDiscovery?: DiscoveredAnthropicAuth | null }
    if (w.__cogniaE2EAnthropicDiscovery !== undefined) {
      return w.__cogniaE2EAnthropicDiscovery
    }
  }
  return await anthropicOauthDiscover()
}

/**
 * Translate a `DiscoveredAnthropicAuth` into the credential shape the vault
 * persists. This is the "Adopt" operation: copy fields verbatim, never mutate
 * Claude Code's source files. From adoption onward the token pair is ours —
 * refresh rotates our vault copy only.
 *
 * Returns `null` when the discovered payload lacks either token — the vault's
 * `validate` requires both, so the renderer should treat that as "credential
 * present but unusable" and fall back to the PKCE flow.
 */
export function discoveredToCredential(
  discovered: DiscoveredAnthropicAuth,
  nowMs: number = Date.now()
): AnthropicCredentialData | null {
  if (!discovered.accessToken.trim() || !discovered.refreshToken.trim()) {
    return null
  }
  return {
    accessToken: discovered.accessToken,
    refreshToken: discovered.refreshToken,
    expiresAtMs: discovered.expiresAtMs,
    // The CLI's claudeAiOauth block is always a claude.ai subscription login
    // (console/API-billing logins never land there).
    mode: "subscription",
    scope: discovered.scopes.length > 0 ? discovered.scopes.join(" ") : undefined,
    plan: discovered.subscriptionType,
    storedAtMs: nowMs,
  }
}

/**
 * Adopt a discovered CLI login into the vault as a new account. Reuses the
 * PKCE persist hook so validation + default-label derivation stay in one
 * place. Throws when the payload is unusable (missing token).
 */
export async function adoptDiscoveredAuth(
  discovered: DiscoveredAnthropicAuth,
  label: string | null = null
): Promise<Account> {
  const credential = discoveredToCredential(discovered)
  if (!credential) {
    throw new Error("discovered Claude Code credential is missing a token pair")
  }
  return await anthropicOauthSavePkceResult(credential, label)
}

/**
 * Full reuse chain: adopt the discovered login and make it the active
 * Anthropic account — which pushes the OAuth bearer into the sidecar env and
 * restarts it, so the very next chat turn runs on the subscription.
 */
export async function adoptAndActivateDiscoveredAuth(
  discovered: DiscoveredAnthropicAuth,
  label: string | null = null
): Promise<Account> {
  const account = await adoptDiscoveredAuth(discovered, label)
  await setActiveAccount("anthropic", account.id)
  return account
}
