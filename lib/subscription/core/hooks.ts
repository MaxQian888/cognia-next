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
import { subscribeSubscriptionChanged } from "./subscription-events"

import {
  deleteProviderPreset,
  getActiveAccount,
  getProviderPreset,
  listAccounts,
  listPresets,
  renameAccount,
  saveProviderPreset,
  setActiveAccount,
  setDefaultPreset,
  setProviderPreset,
} from "./transport"
import { deleteProviderAccount } from "./account-lifecycle"
import type {
  AccountSummary,
  ActiveSnapshot,
  ProviderId,
  ProviderPreset,
} from "@/types/subscription"

// ---------------------------------------------------------------------------
// useAccounts(provider)
// ---------------------------------------------------------------------------

export interface UseAccountsResult {
  /** List of summaries (no secrets). Empty until the first load resolves. */
  accounts: AccountSummary[]
  /** Currently active account id, or `null` when nothing is active. */
  activeAccountId: string | null
  loading: boolean
  error: string | null
  pendingAction: "activate" | "rename" | "delete" | null
  pendingAccountId: string | null
  /** Re-read the vault from the keyring. */
  reload: () => Promise<void>
  /** Set or clear the active account; triggers sidecar restart for Anthropic. */
  setActive: (accountId: string | null) => Promise<void>
  /** Rename an account; `null` clears the label. */
  rename: (accountId: string, label: string | null) => Promise<void>
  /** Delete an account; if active, clears the active pointer. */
  remove: (accountId: string, replacementAccountId?: string | null) => Promise<void>
}

export function useAccounts(provider: ProviderId): UseAccountsResult {
  const [accounts, setAccounts] = useState<AccountSummary[]>([])
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<UseAccountsResult["pendingAction"]>(null)
  const [pendingAccountId, setPendingAccountId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!isTauri()) {
      setAccounts([])
      setActiveAccountId(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [list, snapshot] = await Promise.all([
        listAccounts(provider),
        getActiveAccount(provider),
      ])
      setAccounts(list)
      setActiveAccountId(snapshot.activeAccountId ?? null)
    } catch (loadError) {
      setError(errorMessage(loadError))
      throw loadError
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
          setError(null)
        }
      } catch (loadError) {
        if (alive) setError(errorMessage(loadError))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [provider])

  useEffect(
    () =>
      subscribeSubscriptionChanged(() => {
        void reload().catch(() => undefined)
      }),
    [reload]
  )

  const runAction = useCallback(
    async <T>(
      action: NonNullable<UseAccountsResult["pendingAction"]>,
      accountId: string,
      operation: () => Promise<T>
    ): Promise<T> => {
      setPendingAction(action)
      setPendingAccountId(accountId)
      setError(null)
      try {
        return await operation()
      } catch (actionError) {
        setError(errorMessage(actionError))
        throw actionError
      } finally {
        setPendingAction(null)
        setPendingAccountId(null)
      }
    },
    []
  )

  const setActive = useCallback(
    async (accountId: string | null) => {
      await runAction("activate", accountId ?? "", async () => {
        await setActiveAccount(provider, accountId)
        setActiveAccountId(accountId)
      })
    },
    [provider, runAction]
  )

  const rename = useCallback(
    async (accountId: string, label: string | null) => {
      await runAction("rename", accountId, async () => {
        await renameAccount(provider, accountId, label)
        setAccounts((prev) =>
          prev.map((a) => (a.id === accountId ? { ...a, label: label ?? undefined } : a))
        )
      })
    },
    [provider, runAction]
  )

  const remove = useCallback(
    async (accountId: string, replacementAccountId: string | null = null) => {
      await runAction("delete", accountId, async () => {
        await deleteProviderAccount({ provider, accountId, replacementAccountId })
        setAccounts((prev) => prev.filter((a) => a.id !== accountId))
        if (activeAccountId === accountId) {
          setActiveAccountId(replacementAccountId)
        }
      })
    },
    [provider, activeAccountId, runAction]
  )

  return {
    accounts,
    activeAccountId,
    loading,
    error,
    pendingAction,
    pendingAccountId,
    reload,
    setActive,
    rename,
    remove,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

// ---------------------------------------------------------------------------
// useProviderPresets(provider) — the v3 preset library
// ---------------------------------------------------------------------------

export interface UseProviderPresetsResult {
  /** Every preset in the provider's vault. Empty until the first load resolves. */
  presets: ProviderPreset[]
  /** Provider-level default preset id, or `null` when none is marked default. */
  defaultPresetId: string | null
  loading: boolean
  /** Re-read the library from the keyring. */
  reload: () => Promise<void>
  /** Upsert a preset by id, then refresh the list. */
  save: (preset: ProviderPreset) => Promise<void>
  /** Remove a preset by id (also clears default + bindings server-side). */
  remove: (presetId: string) => Promise<void>
  /** Set or clear the provider-level default preset id. */
  setDefault: (presetId: string | null) => Promise<void>
}

export function useProviderPresets(provider: ProviderId): UseProviderPresetsResult {
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [defaultPresetId, setDefaultPresetId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!isTauri()) {
      setPresets([])
      setDefaultPresetId(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [list, resolved] = await Promise.all([
        listPresets(provider),
        getProviderPreset(provider),
      ])
      setPresets(list)
      setDefaultPresetId(resolved?.id ?? null)
    } finally {
      setLoading(false)
    }
  }, [provider])

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!isTauri()) {
        if (alive) {
          setPresets([])
          setDefaultPresetId(null)
          setLoading(false)
        }
        return
      }
      try {
        const [list, resolved] = await Promise.all([
          listPresets(provider),
          getProviderPreset(provider),
        ])
        if (alive) {
          setPresets(list)
          setDefaultPresetId(resolved?.id ?? null)
        }
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [provider])

  const save = useCallback(
    async (preset: ProviderPreset) => {
      await saveProviderPreset(provider, preset)
      setPresets((prev) => {
        const idx = prev.findIndex((p) => p.id === preset.id)
        if (idx < 0) return [...prev, preset]
        const next = prev.slice()
        next[idx] = preset
        return next
      })
    },
    [provider]
  )

  const remove = useCallback(
    async (presetId: string) => {
      await deleteProviderPreset(provider, presetId)
      setPresets((prev) => prev.filter((p) => p.id !== presetId))
      setDefaultPresetId((prev) => (prev === presetId ? null : prev))
    },
    [provider]
  )

  const setDefault = useCallback(
    async (presetId: string | null) => {
      await setDefaultPreset(provider, presetId)
      setDefaultPresetId(presetId)
    },
    [provider]
  )

  return { presets, defaultPresetId, loading, reload, save, remove, setDefault }
}
