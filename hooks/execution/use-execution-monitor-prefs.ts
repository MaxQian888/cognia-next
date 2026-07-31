"use client"

/**
 * Read + mutate the Execution Monitor view preferences ("围观设置"), persisted on
 * `AppSettings.executionMonitorPrefs` via `useSettingsStore.save()`. Same
 * settings-singleton pattern as `useDiscoverPreferences`, so the chosen view
 * syncs cross-device with no Dexie migration.
 *
 * Consumed by the {@link ExecutionMonitorPanel} header controls.
 */

import { useCallback, useMemo } from "react"

import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  DEFAULT_EXECUTION_MONITOR_PREFS,
  isDefaultExecutionMonitorPrefs,
  resolveExecutionMonitorPrefs,
  type ExecutionMonitorPrefs,
  type ExecutionMonitorSort,
} from "@/lib/execution/monitor-prefs"
import type { ExecutionFilterKind } from "@/lib/execution/monitor-model"

export interface UseExecutionMonitorPrefs {
  prefs: ExecutionMonitorPrefs
  /** Show/hide a single kind (toggles its membership in the deny list). */
  toggleKind: (kind: ExecutionFilterKind, visible: boolean) => Promise<void>
  setSort: (sort: ExecutionMonitorSort) => Promise<void>
  setGroupByKind: (grouped: boolean) => Promise<void>
  setShowElapsed: (show: boolean) => Promise<void>
  /** True when every knob is still at its factory default. */
  isDefault: boolean
  /** Restore all knobs to their defaults. */
  reset: () => Promise<void>
}

export function useExecutionMonitorPrefs(): UseExecutionMonitorPrefs {
  const raw = useSettingsStore((s) => s.settings?.executionMonitorPrefs)
  const save = useSettingsStore((s) => s.save)

  const prefs = useMemo(() => resolveExecutionMonitorPrefs(raw), [raw])

  const persist = useCallback(
    (next: ExecutionMonitorPrefs) => save({ executionMonitorPrefs: next }),
    [save]
  )

  const toggleKind = useCallback(
    async (kind: ExecutionFilterKind, visible: boolean) => {
      const hiddenKinds = visible
        ? prefs.hiddenKinds.filter((k) => k !== kind)
        : prefs.hiddenKinds.includes(kind)
          ? prefs.hiddenKinds
          : [...prefs.hiddenKinds, kind]
      await persist({ ...prefs, hiddenKinds })
    },
    [prefs, persist]
  )

  const setSort = useCallback(
    async (sort: ExecutionMonitorSort) => persist({ ...prefs, sort }),
    [prefs, persist]
  )

  const setGroupByKind = useCallback(
    async (groupByKind: boolean) => persist({ ...prefs, groupByKind }),
    [prefs, persist]
  )

  const setShowElapsed = useCallback(
    async (showElapsed: boolean) => persist({ ...prefs, showElapsed }),
    [prefs, persist]
  )

  const reset = useCallback(async () => persist(DEFAULT_EXECUTION_MONITOR_PREFS), [persist])

  return {
    prefs,
    toggleKind,
    setSort,
    setGroupByKind,
    setShowElapsed,
    isDefault: isDefaultExecutionMonitorPrefs(prefs),
    reset,
  }
}
