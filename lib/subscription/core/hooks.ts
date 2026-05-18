"use client"

// Provider-agnostic React hooks for the ADR-0025 unified subscription module.
//
// Three hooks:
//   * useAccounts(provider)         — live list of accounts + active pointer
//   * useActiveAccount(provider)    — the active account's ActiveSnapshot
//   * useProviderPreset(provider)   — read/write the per-provider preset
//
// All hooks degrade to no-ops outside Tauri (return empty arrays / null).

import { useCallback, useEffect, useState } from "react"

import { isTauri } from "@/lib/tauri"

import {
  deleteAccount,
  getAccount,
  getActiveAccount,
  getProviderPreset,
  listAccounts,
  renameAccount,
  setActiveAccount,
  setProviderPreset,
} from "./transport"
import type { Account, AccountSummary, ActiveSnapshot, ProviderId, ProviderPreset } from "./types"

// ---------------------------------------------------------------------------
// useAccounts(provider)
// ---------------------------------------------------------------------------

export interface UseAccountsResult {
  /** List of summaries (no secrets). Empty until the first load resolves. */
  accounts: AccountSummary[]
  /** Currently active account id, or `null` when nothing is active. */
  activeAccountId: string | null
  loading: boolean
  /** Re-read the vault from the keyring. */
  reload: () => Promise<void>
  /** Set or clear the active account; triggers sidecar restart for Anthropic. */
  setActive: (accountId: string | null) => Promise<void>
  /** Rename an account; `null` clears the label. */
  rename: (accountId: string, label: string | null) => Promise<void>
  /** Delete an account; if active, clears the active pointer. */
  remove: (accountId: string) => Promise<void>
  /** Fetch the full Account (incl. credential) for editing flows. */
  fetchFull: (accountId: string) => Promise<Account | null>
}

export function useAccounts(provider: ProviderId): UseAccountsResult {
  const [accounts, setAccounts] = useState<AccountSummary[]>([])
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!isTauri()) {
      setAccounts([])
      setActiveAccountId(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [list, snapshot] = await Promise.all([
        listAccounts(provider),
        getActiveAccount(provider),
      ])
      setAccounts(list)
      setActiveAccountId(snapshot.activeAccountId ?? null)
    } finally {
      setLoading(false)
    }
  }, [provider])

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!isTauri()) {
        if (alive) {
          setAccounts([])
          setActiveAccountId(null)
          setLoading(false)
        }
        return
      }
      try {
        const [list, snapshot] = await Promise.all([
          listAccounts(provider),
          getActiveAccount(provider),
        ])
        if (alive) {
          setAccounts(list)
          setActiveAccountId(snapshot.activeAccountId ?? null)
        }
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [provider])

  const setActive = useCallback(
    async (accountId: string | null) => {
      await setActiveAccount(provider, accountId)
      setActiveAccountId(accountId)
    },
    [provider]
  )

  const rename = useCallback(
    async (accountId: string, label: string | null) => {
      await renameAccount(provider, accountId, label)
      setAccounts((prev) =>
        prev.map((a) => (a.id === accountId ? { ...a, label: label ?? undefined } : a))
      )
    },
    [provider]
  )

  const remove = useCallback(
    async (accountId: string) => {
      await deleteAccount(provider, accountId)
      setAccounts((prev) => prev.filter((a) => a.id !== accountId))
      if (activeAccountId === accountId) {
        setActiveAccountId(null)
      }
    },
    [provider, activeAccountId]
  )

  const fetchFull = useCallback(
    async (accountId: string) => getAccount(provider, accountId),
    [provider]
  )

  return {
    accounts,
    activeAccountId,
    loading,
    reload,
    setActive,
    rename,
    remove,
    fetchFull,
  }
}

// ---------------------------------------------------------------------------
// useActiveAccount(provider)
// ---------------------------------------------------------------------------

export interface UseActiveAccountResult {
  snapshot: ActiveSnapshot
  loading: boolean
  reload: () => Promise<void>
}

export function useActiveAccount(provider: ProviderId): UseActiveAccountResult {
  const [snapshot, setSnapshot] = useState<ActiveSnapshot>({ env: [] })
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!isTauri()) {
      setSnapshot({ env: [] })
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setSnapshot(await getActiveAccount(provider))
    } finally {
      setLoading(false)
    }
  }, [provider])

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!isTauri()) {
        if (alive) {
          setSnapshot({ env: [] })
          setLoading(false)
        }
        return
      }
      try {
        const got = await getActiveAccount(provider)
        if (alive) setSnapshot(got)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [provider])

  return { snapshot, loading, reload }
}

// ---------------------------------------------------------------------------
// useProviderPreset(provider)
// ---------------------------------------------------------------------------

export interface UseProviderPresetResult {
  preset: ProviderPreset | null
  loading: boolean
  reload: () => Promise<void>
  /** Persist a new preset or clear it (`null`). */
  save: (next: ProviderPreset | null) => Promise<void>
}

export function useProviderPreset(provider: ProviderId): UseProviderPresetResult {
  const [preset, setPreset] = useState<ProviderPreset | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!isTauri()) {
      setPreset(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setPreset(await getProviderPreset(provider))
    } finally {
      setLoading(false)
    }
  }, [provider])

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!isTauri()) {
        if (alive) {
          setPreset(null)
          setLoading(false)
        }
        return
      }
      try {
        const got = await getProviderPreset(provider)
        if (alive) setPreset(got)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [provider])

  const save = useCallback(
    async (next: ProviderPreset | null) => {
      await setProviderPreset(provider, next)
      setPreset(next)
    },
    [provider]
  )

  return { preset, loading, reload, save }
}
