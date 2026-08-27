"use client"

import { useCallback, useEffect, useState } from "react"

import type { PiAuthVerdict } from "@/lib/ai/agent/external/pi-auth"

/**
 * What the Pi credential diagnostic found (ADR-0119).
 *
 * `providers` is deliberately separate from `listing`: an empty provider list
 * under `listing: "ok"` is the real diagnosis this card exists to deliver — Pi
 * is running but cannot reach a single model, which otherwise only surfaces as
 * a failed first prompt. The same empty array under `listing: "unreadable"`
 * means the listing itself failed and says nothing about credentials.
 */
export interface PiAuthStatus {
  listing: "ok" | "unreadable" | "idle"
  verdicts: PiAuthVerdict[]
}

const EMPTY_STATUS: PiAuthStatus = { listing: "idle", verdicts: [] }

/**
 * Run `pi --list-models` and then one `pi auth check` per provider it reports.
 *
 * Manual refresh only, and never on mount-without-connection: each call spawns
 * a short-lived `pi` process through the sandboxed launcher, so this must not
 * become something that polls. Read-only by construction — the adapter pins
 * `--no-refresh`, so the probe cannot mutate Pi's credential store.
 */
export function usePiAuthStatus(
  agentId: string,
  connected: boolean
): {
  status: PiAuthStatus
  loading: boolean
  available: boolean
  refresh: () => Promise<void>
} {
  const [status, setStatus] = useState<PiAuthStatus>(EMPTY_STATUS)
  const [loading, setLoading] = useState(false)
  const [available, setAvailable] = useState(false)

  const refresh = useCallback(async () => {
    if (!connected) return
    const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
    const adapter = getExternalAgentManager().getPiRpcAdapter(agentId)
    if (!adapter) return
    setLoading(true)
    try {
      const listing = await adapter.listModelProviders()
      if (listing.status !== "ok") {
        setStatus({ listing: "unreadable", verdicts: [] })
        return
      }
      // Sequential on purpose: each check is a process spawn under the sandbox
      // launcher, and a user with many providers should not fan out a dozen at
      // once just to render a list of badges.
      const verdicts: PiAuthVerdict[] = []
      for (const provider of listing.providers) {
        verdicts.push(await adapter.checkProviderAuth(provider))
      }
      setStatus({ listing: "ok", verdicts })
    } catch {
      // A spawn that never started — `pi` gone from PATH, no sandbox launcher
      // on this host — is exactly "could not check", and it must be caught
      // here: the effect below calls this as `void refresh()`, so a rejection
      // would escape as an unhandled promise rejection instead of reaching the
      // user as a diagnosis.
      setStatus({ listing: "unreadable", verdicts: [] })
    } finally {
      setLoading(false)
    }
  }, [agentId, connected])

  useEffect(() => {
    let active = true
    void (async () => {
      if (!connected) {
        if (active) {
          setStatus(EMPTY_STATUS)
          setAvailable(false)
        }
        return
      }
      const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
      const adapter = getExternalAgentManager().getPiRpcAdapter(agentId)
      if (!adapter || !active) return
      setAvailable(true)
      void refresh()
    })()
    return () => {
      active = false
    }
  }, [agentId, connected, refresh])

  return { status, loading, available, refresh }
}
