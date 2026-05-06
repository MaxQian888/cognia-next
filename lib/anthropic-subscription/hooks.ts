"use client"

// React hooks for the Claude subscription subsystem. Two reads + one write:
//
//   useSubscriptionCredential()  — keychain → state, refreshes on demand
//   useSubscriptionUsage()       — Dexie liveQuery on subscriptionUsage
//   useSubscriptionLogout()      — clear keychain + sidecar in one call
//
// All hooks are no-ops outside Tauri (they return null / empty arrays).

import { useCallback, useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { isTauri } from "@/lib/tauri"
import { getDb } from "@/lib/db/schema"

import {
  clearCredential,
  isCredentialFresh,
  loadCredential,
  saveCredential,
} from "./credential-store"
import { refreshAccessToken } from "./oauth"
import { clearCredentialFromSidecar, syncCredentialToSidecar } from "./sidecar-sync"
import type { SubscriptionCredential, SubscriptionUsageRow } from "./types"

export interface UseSubscriptionCredentialResult {
  credential: SubscriptionCredential | null
  isFresh: boolean
  loading: boolean
  /** Re-read from the keyring. Useful after the login dialog persists. */
  reload: () => Promise<void>
  /** Force a refresh exchange and persist the rotated tokens. */
  refresh: () => Promise<SubscriptionCredential | null>
  /** Clear the keyring entry + clear the sidecar bearer. */
  signOut: () => Promise<void>
}

export function useSubscriptionCredential(): UseSubscriptionCredentialResult {
  const [credential, setCredential] = useState<SubscriptionCredential | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!isTauri()) {
      await Promise.resolve()
      setCredential(null)
      setLoading(false)
      return
    }
    try {
      const got = await loadCredential()
      setCredential(got)
    } finally {
      setLoading(false)
    }
  }, [])

  const refresh = useMemo(
    () => async () => {
      if (!credential) return null
      const updated = await refreshAccessToken({
        refreshToken: credential.refreshToken,
        mode: credential.mode,
      })
      // Preserve email/plan from the prior credential if the refresh response
      // doesn't include them (some servers omit `account` on refresh).
      const merged: SubscriptionCredential = {
        ...credential,
        ...updated,
        email: updated.email ?? credential.email,
        plan: updated.plan ?? credential.plan,
      }
      await saveCredential(merged)
      await syncCredentialToSidecar(merged)
      setCredential(merged)
      return merged
    },
    [credential]
  )

  const signOut = useMemo(
    () => async () => {
      await clearCredential()
      await clearCredentialFromSidecar()
      setCredential(null)
    },
    []
  )

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!isTauri()) {
        if (alive) {
          setCredential(null)
          setLoading(false)
        }
        return
      }
      try {
        const got = await loadCredential()
        if (alive) setCredential(got)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  return {
    credential,
    isFresh: isCredentialFresh(credential),
    loading,
    reload,
    refresh,
    signOut,
  }
}

export interface UseSubscriptionUsageResult {
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
export function useSubscriptionUsage(limit: number = 200): UseSubscriptionUsageResult {
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
