"use client"

/**
 * Read + change which rows the session summary card shows. Lives on
 * `settings.sessionSummaryCard`, written through `useSettingsStore.save()` —
 * the same path as every other shell customization, so no Dexie migration.
 */

import { useCallback, useMemo } from "react"

import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  DEFAULT_SUMMARY_CARD_ROWS,
  resolveSummaryCardRows,
  type SummaryCardRowId,
  type SummaryCardRowVisibility,
} from "@/types/shell/session-summary-card"

export interface UseSessionSummaryCardPrefs {
  rows: Record<SummaryCardRowId, SummaryCardRowVisibility>
  /** True when every row is at its shipped visibility. */
  isDefault: boolean
  setRow: (id: SummaryCardRowId, visibility: SummaryCardRowVisibility) => Promise<void>
  reset: () => Promise<void>
}

export function useSessionSummaryCardPrefs(): UseSessionSummaryCardPrefs {
  const save = useSettingsStore((s) => s.save)
  // The single field, not the whole settings object: every write swaps in a
  // fresh `settings` reference and this hook sits in the chat header.
  const stored = useSettingsStore((s) => s.settings?.sessionSummaryCard)
  const rows = useMemo(() => resolveSummaryCardRows(stored), [stored])
  const isDefault = useMemo(
    () =>
      (Object.keys(DEFAULT_SUMMARY_CARD_ROWS) as SummaryCardRowId[]).every(
        (id) => rows[id] === DEFAULT_SUMMARY_CARD_ROWS[id]
      ),
    [rows]
  )

  const setRow = useCallback(
    (id: SummaryCardRowId, visibility: SummaryCardRowVisibility) =>
      save({ sessionSummaryCard: { rows: { ...(stored?.rows ?? {}), [id]: visibility } } }),
    [save, stored]
  )
  const reset = useCallback(() => save({ sessionSummaryCard: { rows: {} } }), [save])

  return { rows, isDefault, setRow, reset }
}
