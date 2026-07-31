"use client"

/**
 * Read + mutate the Source Control panel preferences, persisted on
 * `AppSettings.gitSettings.panel` via `useSettingsStore.save()`. Same
 * settings-singleton pattern as `useExecutionMonitorPrefs`, so the chosen view
 * syncs cross-device with no Dexie migration.
 *
 * Writes spread `...gitSettings` so the sibling `commitMessageAI` block is
 * preserved when only the panel prefs change.
 *
 * Consumed by the panel's gear popover ({@link SourceControlViewSettings}), the
 * sync toolbar, the diff viewer, the commit box, and the Settings section.
 */

import { useCallback, useMemo } from "react"

import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_GIT_SETTINGS } from "@/types/git"
import {
  DEFAULT_SOURCE_CONTROL_PANEL_PREFS,
  isDefaultSourceControlPanelPrefs,
  resolveSourceControlPanelPrefs,
  type BranchSortMode,
  type DiffViewMode,
  type PostCommitAction,
  type SourceControlPanelPrefs,
  type TimelineDefaultView,
} from "@/lib/git/panel-prefs"

export interface UseSourceControlPrefs {
  prefs: SourceControlPanelPrefs
  setDiffView: (mode: DiffViewMode) => Promise<void>
  setIgnoreWhitespace: (ignore: boolean) => Promise<void>
  setConfirmDiscard: (confirm: boolean) => Promise<void>
  setConfirmForcePush: (confirm: boolean) => Promise<void>
  setSmartCommit: (enabled: boolean) => Promise<void>
  setPostCommit: (action: PostCommitAction) => Promise<void>
  setPullRebase: (rebase: boolean) => Promise<void>
  setFetchPrune: (prune: boolean) => Promise<void>
  setAutoFetch: (enabled: boolean) => Promise<void>
  setAutoFetchInterval: (minutes: number) => Promise<void>
  setBranchSort: (mode: BranchSortMode) => Promise<void>
  setDefaultTimelineView: (view: TimelineDefaultView) => Promise<void>
  /** True when every knob is still at its factory default. */
  isDefault: boolean
  /** Restore all knobs to their defaults. */
  reset: () => Promise<void>
}

export function useSourceControlPrefs(): UseSourceControlPrefs {
  const gitSettings = useSettingsStore((s) => s.settings?.gitSettings)
  const save = useSettingsStore((s) => s.save)

  const prefs = useMemo(
    () => resolveSourceControlPanelPrefs(gitSettings?.panel),
    [gitSettings?.panel]
  )

  const persist = useCallback(
    (next: SourceControlPanelPrefs) =>
      save({
        gitSettings: {
          ...gitSettings,
          // Keep the sibling AI block intact (and satisfy the required field
          // when no gitSettings row exists yet).
          commitMessageAI: gitSettings?.commitMessageAI ?? DEFAULT_GIT_SETTINGS.commitMessageAI,
          panel: next,
        },
      }),
    [gitSettings, save]
  )

  const setDiffView = useCallback(
    async (diffView: DiffViewMode) => persist({ ...prefs, diffView }),
    [prefs, persist]
  )
  const setIgnoreWhitespace = useCallback(
    async (ignoreWhitespace: boolean) => persist({ ...prefs, ignoreWhitespace }),
    [prefs, persist]
  )
  const setConfirmDiscard = useCallback(
    async (confirmDiscard: boolean) => persist({ ...prefs, confirmDiscard }),
    [prefs, persist]
  )
  const setConfirmForcePush = useCallback(
    async (confirmForcePush: boolean) => persist({ ...prefs, confirmForcePush }),
    [prefs, persist]
  )
  const setSmartCommit = useCallback(
    async (smartCommit: boolean) => persist({ ...prefs, smartCommit }),
    [prefs, persist]
  )
  const setPostCommit = useCallback(
    async (postCommit: PostCommitAction) => persist({ ...prefs, postCommit }),
    [prefs, persist]
  )
  const setPullRebase = useCallback(
    async (pullRebase: boolean) => persist({ ...prefs, pullRebase }),
    [prefs, persist]
  )
  const setFetchPrune = useCallback(
    async (fetchPrune: boolean) => persist({ ...prefs, fetchPrune }),
    [prefs, persist]
  )
  const setAutoFetch = useCallback(
    async (autoFetch: boolean) => persist({ ...prefs, autoFetch }),
    [prefs, persist]
  )
  const setAutoFetchInterval = useCallback(
    async (autoFetchIntervalMinutes: number) => persist({ ...prefs, autoFetchIntervalMinutes }),
    [prefs, persist]
  )
  const setBranchSort = useCallback(
    async (branchSort: BranchSortMode) => persist({ ...prefs, branchSort }),
    [prefs, persist]
  )
  const setDefaultTimelineView = useCallback(
    async (defaultTimelineView: TimelineDefaultView) => persist({ ...prefs, defaultTimelineView }),
    [prefs, persist]
  )

  const reset = useCallback(async () => persist(DEFAULT_SOURCE_CONTROL_PANEL_PREFS), [persist])

  return {
    prefs,
    setDiffView,
    setIgnoreWhitespace,
    setConfirmDiscard,
    setConfirmForcePush,
    setSmartCommit,
    setPostCommit,
    setPullRebase,
    setFetchPrune,
    setAutoFetch,
    setAutoFetchInterval,
    setBranchSort,
    setDefaultTimelineView,
    isDefault: isDefaultSourceControlPanelPrefs(prefs),
    reset,
  }
}
