"use client"

// Provider-agnostic React hooks for the ADR-0025 unified subscription module.
//
// Three hooks:
//   * useAccounts(provider)         — live list of accounts + active pointer
//   * useActiveAccount(provider)    — the active account's ActiveSnapshot
//   * useProviderPreset(provider)   — read/write the per-provider preset
//
// All hooks degrade to no-ops outside Tauri (return empty arrays / null).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useAccountStore } from "@/stores/account/account-store"
import {
  listSubscriptionProviders,
  subscribeSubscriptionProviders,
  type SubscriptionProviderDefinition,
} from "./provider-registry"

import { isTauri } from "@/lib/tauri"
import { subscribeSubscriptionChanged } from "./subscription-events"

import {
  deleteProviderPreset,
  getActiveAccount,
  getProviderPreset,
  listAccounts,
  listSubscriptionProviderIds,
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

export function useSubscriptionProviders(): SubscriptionProviderDefinition[] {
  const customs = useSettingsStore((state) => state.settings?.customProviders)
  const [revision, setRevision] = useState(0)
  useEffect(() => subscribeSubscriptionProviders(() => setRevision((value) => value + 1)), [])
  // The mutable registry changes independently of the settings snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => listSubscriptionProviders(customs), [customs, revision])
}

/** One subscription listener regardless of the number of registered suppliers. */
export function useSubscriptionAccounts() {
  const registered = useSubscriptionProviders()
  const localAccountId = useAccountStore((state) => state.unlockedAccountId)
  const [storedProviders, setProviders] = useState(registered)
  const [loadedScope, setLoadedScope] = useState<string | null | undefined>(undefined)
  const scope = useRef(localAccountId)
  useLayoutEffect(() => {
    scope.current = localAccountId
  }, [localAccountId])
  const sameScope = loadedScope === localAccountId
  const providers = sameScope ? storedProviders : registered
  const [rows, setRows] = useState<
    Record<string, Pick<UseAccountsResult, "accounts" | "activeAccountId" | "error">>
  >({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<
    Record<string, { action: UseAccountsResult["pendingAction"]; accountId: string }>
  >({})
  const generation = useRef(0)
  const reload = useCallback(async () => {
    const current = ++generation.current
    if (!isTauri() || !localAccountId) {
      setProviders(registered)
      setRows({})
      setLoadedScope(localAccountId)
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const inventory = await listSubscriptionProviderIds()
      const definitions = [...registered]
      for (const id of inventory) {
        if (!definitions.some((definition) => definition.id === id)) {
          definitions.push({
            id,
            name: id,
            authMode: "api-key",
            source: "unavailable",
            available: false,
          })
        }
      }
      const entries = await Promise.all(
        definitions.map(async (definition) => {
          try {
            const [accounts, active] = await Promise.all([
              listAccounts(definition.id),
              getActiveAccount(definition.id),
            ])
            return [
              definition.id,
              { accounts, activeAccountId: active.activeAccountId ?? null, error: null },
            ] as const
          } catch (cause) {
            return [
              definition.id,
              { accounts: [], activeAccountId: null, error: errorMessage(cause) },
            ] as const
          }
        })
      )
      if (current !== generation.current) return
      setProviders(definitions)
      setLoadedScope(localAccountId)
      setRows(Object.fromEntries(entries))
    } catch (cause) {
      if (current === generation.current) {
        setRows({})
        setProviders(registered)
        setLoadedScope(localAccountId)
        setError(errorMessage(cause))
      }
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [registered, localAccountId])
  useEffect(() => {
    setPending({})
    void reload()
    const unsubscribe = subscribeSubscriptionChanged(() => {
      void reload()
    })
    return () => {
      generation.current += 1
      unsubscribe()
    }
  }, [reload])
  const byProvider = useMemo(
    () =>
      Object.fromEntries(
        providers.map((provider) => {
          const run = async (
            action: NonNullable<UseAccountsResult["pendingAction"]>,
            accountId: string,
            operation: () => Promise<unknown>
          ) => {
            if (scope.current !== localAccountId || !localAccountId)
              throw new Error("Local account changed")
            setPending((value) => ({ ...value, [provider.id]: { action, accountId } }))
            try {
              await operation()
              // Mutating transport calls publish subscriptionChanged; that listener
              // owns the refresh so one action does not read every vault twice.
            } catch (cause) {
              if (scope.current !== localAccountId) throw cause
              setRows((value) => ({
                ...value,
                [provider.id]: {
                  accounts: value[provider.id]?.accounts ?? [],
                  activeAccountId: value[provider.id]?.activeAccountId ?? null,
                  error: errorMessage(cause),
                },
              }))
              throw cause
            } finally {
              if (scope.current === localAccountId)
                setPending((value) => {
                  const next = { ...value }
                  delete next[provider.id]
                  return next
                })
            }
          }
          const result: UseAccountsResult = {
            accounts: sameScope ? (rows[provider.id]?.accounts ?? []) : [],
            activeAccountId: sameScope ? (rows[provider.id]?.activeAccountId ?? null) : null,
            error: sameScope ? (rows[provider.id]?.error ?? null) : null,
            loading,
            pendingAction: pending[provider.id]?.action ?? null,
            pendingAccountId: pending[provider.id]?.accountId ?? null,
            reload,
            setActive: (id) => run("activate", id ?? "", () => setActiveAccount(provider.id, id)),
            rename: (id, label) => run("rename", id, () => renameAccount(provider.id, id, label)),
            remove: (id, replacementAccountId = null) =>
              run("delete", id, () =>
                deleteProviderAccount({
                  provider: provider.id,
                  accountId: id,
                  replacementAccountId,
                })
              ),
          }
          return [provider.id, result]
        })
      ),
    [providers, rows, pending, loading, reload, sameScope, localAccountId]
  )
  return {
    providers,
    byProvider,
    loading: !sameScope || loading,
    error: sameScope ? error : null,
    reload,
  }
}

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
