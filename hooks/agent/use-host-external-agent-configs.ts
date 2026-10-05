"use client"

/**
 * The host's external-agent configurations, as this client can see them.
 *
 * Deliberately a plain `useState` + `useCallback` loader rather than a store.
 * These rows are not this client's state — they belong to a host that other
 * clients are editing at the same time, and the compare-and-swap on every write
 * is what makes that safe. A local cache pretending to be the truth would only
 * make a conflict look like a bug.
 *
 * The availability check runs on every load rather than once, because the
 * active host changes underneath a long-lived tab: pairing to a different
 * machine has to move this list, not leave a stale one on screen.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  HOST_CONFIG_COMMANDS,
  HostConfigsUnsupportedError,
  createRemoteHostConfig,
  deleteRemoteHostConfig,
  duplicateRemoteHostConfig,
  hostConfigsAvailability,
  listRemoteHostConfigs,
  reconcileRemoteHostConfigs,
  updateRemoteHostConfig,
  type HostConfigsUnavailableReason,
  type RemoteHostConfigDuplicateOptions,
} from "@/lib/ai/agent/external/runtimes/remote/remote-host-configs"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"
import type { StoredExternalAgentConfig } from "@/stores/agent/external-agent-store/types"

export interface HostExternalAgentConfigsState {
  configs: ExternalAgentConfigRecord[]
  loading: boolean
  /** Present when the host cannot serve this surface at all. */
  unavailable: HostConfigsUnavailableReason | null
  /** A failed call, kept so the panel can show it without a toast being the only trace. */
  error: string | null
  refresh: () => Promise<void>
  reconcile: () => Promise<void>
  setEnabled: (record: ExternalAgentConfigRecord, enabled: boolean) => Promise<void>
  /**
   * A shallow edit, compare-and-swapped on the revision the row was read at.
   * Resolves `false` when the host refused it; the reason is in `error`.
   */
  update: (
    record: ExternalAgentConfigRecord,
    patch: Partial<StoredExternalAgentConfig>
  ) => Promise<boolean>
  /** Resolves `false` when the host refused; the reason is in `error`. */
  remove: (record: ExternalAgentConfigRecord) => Promise<boolean>
  /**
   * Copy a locally-configured agent onto the host.
   *
   * The panel's empty state has always told the user to do this and there was
   * no control behind the sentence: `createRemoteHostConfig` shipped with the
   * client and had no caller, so a browser could configure an agent it could
   * never run and select it in chat anyway, which failed the turn with
   * `Agent not found`. `fromImport` is what makes the host strip the keyring
   * references and consents that only mean something on the sending machine.
   */
  copyLocal: (config: StoredExternalAgentConfig) => Promise<void>
  /**
   * Create a new configuration on the host — the phone's "add agent", which
   * has no local store to copy from. Unlike `copyLocal` this is not an import:
   * the caller is configuring the host directly, so nothing is stripped.
   * Resolves the created row, or the host's reason for refusing it (also kept
   * in `error`, which a caller reading it right after the await would see one
   * render late).
   */
  create: (
    config: Partial<StoredExternalAgentConfig>
  ) => Promise<{ ok: true; record: ExternalAgentConfigRecord } | { ok: false; error: string }>
  /**
   * Copy a Host configuration into a new one on the Host (ADR-0216). The Host
   * copies the source's keyring secrets into the copy's own slots; nothing is
   * connected. Resolves the created row, or the Host's reason for refusing.
   */
  duplicate: (
    record: ExternalAgentConfigRecord,
    options?: RemoteHostConfigDuplicateOptions
  ) => Promise<{ ok: true; record: ExternalAgentConfigRecord } | { ok: false; error: string }>
  /** True while any write is in flight; the panel disables its controls. */
  busy: boolean
}

export function useHostExternalAgentConfigs(): HostExternalAgentConfigsState {
  const [configs, setConfigs] = useState<ExternalAgentConfigRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [unavailable, setUnavailable] = useState<HostConfigsUnavailableReason | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const availability = hostConfigsAvailability(HOST_CONFIG_COMMANDS.list)
    if (!availability.ok) {
      setUnavailable(availability.reason)
      setConfigs([])
      setLoading(false)
      return
    }
    setUnavailable(null)
    setLoading(true)
    try {
      setConfigs(await listRemoteHostConfigs())
      setError(null)
    } catch (cause) {
      if (cause instanceof HostConfigsUnsupportedError) setUnavailable(cause.reason)
      else setError(cause instanceof Error ? cause.message : String(cause))
      setConfigs([])
    } finally {
      setLoading(false)
    }
  }, [])

  // The load is wrapped rather than called directly because every state write
  // in `refresh` happens after an await, and an effect that calls a setState-ing
  // callback synchronously is what `react-hooks/set-state-in-effect` forbids for
  // `hooks/**`. The wrapper is also the only place an initial-load failure can
  // be swallowed: `refresh` already records it in `error`, so a rejected promise
  // here would only be an unhandled rejection.
  useEffect(() => {
    const load = async () => {
      await refresh()
    }
    void load()
  }, [refresh])

  /**
   * Every write re-reads afterwards instead of patching the row in place.
   * The host may have changed more than the caller asked for — a disable that
   * fails readiness comes back with a new lifecycle status and a bumped
   * generation — and a local patch would show the user the edit they made
   * rather than the state the host is in.
   */
  const mutate = useCallback(
    async <T>(
      run: () => Promise<T>
    ): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
      setBusy(true)
      let failure: string | null = null
      let outcome: { ok: true; value: T } | { ok: false; error: string }
      try {
        outcome = { ok: true, value: await run() }
      } catch (cause) {
        failure = cause instanceof Error ? cause.message : String(cause)
        outcome = { ok: false, error: failure }
      }
      // The refresh runs BEFORE the failure is recorded, not after. A refresh
      // that succeeds clears `error` — so setting the write's failure first
      // would have it wiped a moment later, and a rejected compare-and-swap
      // would look like it had silently worked.
      await refresh()
      setError(failure)
      setBusy(false)
      return outcome
    },
    [refresh]
  )

  const update = useCallback(
    async (record: ExternalAgentConfigRecord, patch: Partial<StoredExternalAgentConfig>) =>
      (
        await mutate(() =>
          updateRemoteHostConfig({
            configId: record.configId,
            expectedRevision: record.revision,
            patch,
          })
        )
      ).ok,
    [mutate]
  )

  const setEnabled = useCallback(
    async (record: ExternalAgentConfigRecord, enabled: boolean) => {
      await update(record, { enabled })
    },
    [update]
  )

  const remove = useCallback(
    async (record: ExternalAgentConfigRecord) =>
      (await mutate(() => deleteRemoteHostConfig(record.configId))).ok,
    [mutate]
  )

  const reconcile = useCallback(async () => {
    await mutate(() => reconcileRemoteHostConfigs())
  }, [mutate])

  const copyLocal = useCallback(
    async (config: StoredExternalAgentConfig) => {
      await mutate(() => createRemoteHostConfig(config, { fromImport: true }))
    },
    [mutate]
  )

  const create = useCallback(
    async (config: Partial<StoredExternalAgentConfig>) => {
      const outcome = await mutate(() => createRemoteHostConfig(config))
      return outcome.ok
        ? { ok: true as const, record: outcome.value }
        : { ok: false as const, error: outcome.error }
    },
    [mutate]
  )

  const duplicate = useCallback(
    async (record: ExternalAgentConfigRecord, options: RemoteHostConfigDuplicateOptions = {}) => {
      const outcome = await mutate(() => duplicateRemoteHostConfig(record.configId, options))
      return outcome.ok
        ? { ok: true as const, record: outcome.value }
        : { ok: false as const, error: outcome.error }
    },
    [mutate]
  )

  return useMemo(
    () => ({
      configs,
      loading,
      unavailable,
      error,
      refresh,
      reconcile,
      setEnabled,
      update,
      remove,
      copyLocal,
      create,
      duplicate,
      busy,
    }),
    [
      configs,
      loading,
      unavailable,
      error,
      refresh,
      reconcile,
      setEnabled,
      update,
      remove,
      copyLocal,
      create,
      duplicate,
      busy,
    ]
  )
}
