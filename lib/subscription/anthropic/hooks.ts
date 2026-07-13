"use client"

// Anthropic-only React hooks. The two surfaces here are:
//   * The historical usage table — `useAnthropicUsage`.
//   * A convenience accessor `useActiveAnthropicCredential` for the rich
//     credential payload (email / plan / expiry) the Overview + Account
//     panels render. Provider-agnostic CRUD lives in `core/hooks.ts`.

import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { isTauri } from "@/lib/tauri"
import { getDb } from "@/lib/db/schema"

import { anthropicOauthSavePkceResult, getAccount, setActiveAccount } from "../core/transport"
import { discoverAnthropicAuth, type DiscoveredAnthropicAuth } from "./discovery"
import { refreshAccessToken } from "./oauth"
import type {
  AnthropicCredentialData,
  ProviderCredential,
  SubscriptionUsageRow,
} from "@/types/subscription"
import { useAccounts } from "../core/hooks"

export interface UseAnthropicUsageResult {
  rows: SubscriptionUsageRow[]
  latest: SubscriptionUsageRow | null
  loading: boolean
}

/**
 * Live `subscriptionUsage` rows ordered by fetchedAt descending. The Overview
 * tab only needs `latest`; the Usage tab walks `rows` for the chart.
 *
 * `limit` defaults to 200 — enough for a 7-day chart with one passive sample
 * every couple of minutes plus a few probes.
 */
export function useAnthropicUsage(limit: number = 200): UseAnthropicUsageResult {
  const rows =
    useLiveQuery(
      async () => getDb().subscriptionUsage.orderBy("fetchedAt").reverse().limit(limit).toArray(),
      [limit]
    ) ?? null

  return {
    rows: rows ?? [],
    latest: rows && rows.length > 0 ? rows[0] : null,
    loading: rows === null,
  }
}

export interface UseActiveAnthropicCredentialResult {
  /** UUIDv7 of the active account, or `null` when nothing is active. */
  activeAccountId: string | null
  /** Rich credential payload for the active account. */
  credential: AnthropicCredentialData | null
  loading: boolean
  /** Re-read the active account from the vault. */
  reload: () => Promise<void>
  /** Trigger a refresh exchange + persist + sidecar restart. */
  refresh: () => Promise<AnthropicCredentialData | null>
  /** Clear the active pointer (sidecar reverts to API-key auth on next spawn). */
  signOut: () => Promise<void>
}

/**
 * Read the active Anthropic account's full credential. Composes
 * `useAccounts("anthropic")` with a `subscription_get_account` round-trip
 * for the active id so the Overview / Account panes can render
 * email / plan / expiry without going through the IPC themselves.
 */
export function useActiveAnthropicCredential(): UseActiveAnthropicCredentialResult {
  const { activeAccountId, reload: reloadAccounts } = useAccounts("anthropic")
  const [credential, setCredential] = useState<AnthropicCredentialData | null>(null)
  const [loading, setLoading] = useState(true)

  const loadActive = useCallback(async (id: string | null) => {
    if (!isTauri() || !id) {
      setCredential(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const account = await getAccount("anthropic", id)
      if (account && isAnthropicCredential(account.credential)) {
        setCredential({
          accessToken: account.credential.accessToken,
          refreshToken: account.credential.refreshToken,
          expiresAtMs: account.credential.expiresAtMs,
          mode: account.credential.mode,
          scope: account.credential.scope,
          email: account.credential.email,
          plan: account.credential.plan,
          storedAtMs: account.credential.storedAtMs,
        })
      } else {
        setCredential(null)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      await loadActive(activeAccountId)
      if (!alive) return
    })()
    return () => {
      alive = false
    }
  }, [activeAccountId, loadActive])

  const reload = useCallback(async () => {
    await reloadAccounts()
    await loadActive(activeAccountId)
  }, [activeAccountId, loadActive, reloadAccounts])

  const refresh = useCallback(async () => {
    if (!credential || !activeAccountId) return null
    const updated = await refreshAccessToken({
      refreshToken: credential.refreshToken,
      mode: credential.mode,
    })
    const merged: AnthropicCredentialData = {
      ...credential,
      ...updated,
      email: updated.email ?? credential.email,
      plan: updated.plan ?? credential.plan,
    }
    // `anthropic_oauth_save_pkce_result` deliberately APPENDS a new account
    // instead of updating in-place, which is wrong for refresh — but we can
    // model refresh as "update the active credential in the vault" by
    // round-tripping through `subscription_save_account`. We achieve that
    // by saving a new Account with the SAME id, which the Rust vault layer
    // treats as an upsert.
    const account = await getAccount("anthropic", activeAccountId)
    if (!account) return null
    const next = {
      ...account,
      credential: { provider: "anthropic" as const, ...merged },
      lastUsedAtMs: Date.now(),
    }
    const { saveAccount } = await import("../core/transport")
    await saveAccount("anthropic", next)
    // Re-activate so the in-process bearer + sidecar pick up the new token.
    await setActiveAccount("anthropic", activeAccountId)
    setCredential(merged)
    return merged
  }, [activeAccountId, credential])

  const signOut = useCallback(async () => {
    if (!isTauri()) return
    await setActiveAccount("anthropic", null)
    setCredential(null)
  }, [])

  return { activeAccountId, credential, loading, reload, refresh, signOut }
}

export interface UseAnthropicDiscoveryResult {
  discovered: DiscoveredAnthropicAuth | null
  loading: boolean
  error: string | null
  /** Force a re-probe (e.g. after the user runs `claude login` in a terminal). */
  reload: () => Promise<void>
}

export interface UseAnthropicDiscoveryOptions {
  /**
   * Gate the automatic mount-time probe. Defaults to `true`. Pass `false` when
   * the caller already holds an Anthropic credential — the probe reads Claude
   * Code's OWN `"Claude Code-credentials"` keychain item, which is a separate
   * OS-keyring entry from our vault's master key and therefore triggers its own
   * macOS keychain prompt every time. Skipping it when the discovered result
   * would be discarded avoids a redundant, blocking password prompt.
   * `reload()` still probes on demand regardless of this flag.
   */
  enabled?: boolean
}

/**
 * Probe for an existing local Claude Code CLI subscription login. Mirrors
 * `useCodexDiscovery` — desktop-only (returns `null` on web), read-only.
 */
export function useAnthropicDiscovery(
  options: UseAnthropicDiscoveryOptions = {}
): UseAnthropicDiscoveryResult {
  const { enabled = true } = options
  const [discovered, setDiscovered] = useState<DiscoveredAnthropicAuth | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!isTauri()) {
      setDiscovered(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const got = await discoverAnthropicAuth()
      setDiscovered(got)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setDiscovered(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      // `enabled: false` (e.g. a credential is already active) skips the probe
      // entirely so Claude Code's keychain item is never touched — no redundant
      // macOS keychain prompt.
      if (!enabled || !isTauri()) {
        if (alive) {
          setDiscovered(null)
          setLoading(false)
        }
        return
      }
      if (alive) setLoading(true)
      try {
        const got = await discoverAnthropicAuth()
        if (alive) setDiscovered(got)
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [enabled])

  return { discovered, loading, error, reload }
}

function isAnthropicCredential(
  c: ProviderCredential
): c is Extract<ProviderCredential, { provider: "anthropic" }> {
  return c.provider === "anthropic"
}

/**
 * Re-export so callers that want to mint a brand-new account from a fresh
 * PKCE exchange don't have to thread through `core/transport.ts`.
 */
export { anthropicOauthSavePkceResult }
