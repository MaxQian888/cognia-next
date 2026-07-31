"use client"

// Renderer-side facade over `opencode_oauth_discover`. Returns the same shape
// the Rust side emits, plus a React hook that probes on mount + re-probes on
// demand (e.g. after the user runs `opencode auth` in a terminal).

import { useCallback, useEffect, useState } from "react"

import { isTauri } from "@/lib/tauri"

import {
  opencodeOauthDiscover,
  opencodeSaveZenKey,
  type DiscoveredOpencodeAuth,
  type DiscoveredOpencodeEntry,
} from "../core/transport"
import type { Account, OpencodePlan } from "@/types/subscription"
import { isWhitelistedOpencodeSubProvider } from "@/types/subscription"

export type { DiscoveredOpencodeAuth, DiscoveredOpencodeEntry }

/**
 * Probe the OpenCode CLI's auth.json. Returns `null` when the path isn't
 * resolvable on this host (e.g. headless CI without a home dir); otherwise
 * returns the (possibly empty) entry list — the Rust side already filtered
 * to the whitelist.
 *
 * The TS layer applies the whitelist a second time as defence-in-depth: if
 * a future Rust regression accidentally surfaces an unknown sub-provider,
 * the renderer still drops it.
 */
export async function discoverOpencodeAuth(): Promise<DiscoveredOpencodeAuth | null> {
  const got = await opencodeOauthDiscover()
  if (!got) return null
  return {
    authJsonPath: got.authJsonPath,
    entries: got.entries.filter((entry) => isWhitelistedOpencodeSubProvider(entry.subProvider)),
  }
}

/**
 * Persist a pasted OpenCode managed-plan API key (Zen or Go). Returns the
 * newly-created `Account` (so the renderer can immediately call
 * `subscription_set_active` to make it active).
 */
export async function saveOpencodeZenKey(input: {
  accessToken: string
  baseUrl?: string
  label?: string
  plan?: OpencodePlan
}): Promise<Account> {
  return await opencodeSaveZenKey(
    input.accessToken,
    input.baseUrl?.trim() || null,
    input.label?.trim() || null,
    input.plan ?? null
  )
}

export interface UseOpencodeDiscoveryResult {
  discovered: DiscoveredOpencodeAuth | null
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

export function useOpencodeDiscovery(): UseOpencodeDiscoveryResult {
  const [discovered, setDiscovered] = useState<DiscoveredOpencodeAuth | null>(null)
  const [loading, setLoading] = useState(true)
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
      setDiscovered(await discoverOpencodeAuth())
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
      if (!isTauri()) {
        if (alive) {
          setDiscovered(null)
          setLoading(false)
        }
        return
      }
      try {
        const got = await discoverOpencodeAuth()
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
  }, [])

  return { discovered, loading, error, reload }
}
