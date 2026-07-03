"use client"

import { useEffect, useMemo, useRef } from "react"
import { useSettingsStore, resolveSkillPanelPrefs } from "@/stores/settings"
import type { SkillPanelPrefs, LastSkillView } from "@/lib/skills/preferences"
import { useSkillsStore } from "@/stores/skills"

/**
 * Resolve the user's Skills-panel preferences (display + persistence +
 * injection) from settings, applying defaults. Selects the raw stored field so
 * Zustand's referential equality holds across renders (wrapping the resolver in
 * the selector would mint a fresh object every read — see the note in
 * `skill-panel-toolbar.tsx`), then resolves once per raw-value change.
 */
export function useSkillPanelPrefs(): SkillPanelPrefs {
  const raw = useSettingsStore((s) => s.settings?.skillPanelPrefs)
  return useMemo(() => resolveSkillPanelPrefs(raw), [raw])
}

/** Debounce window (ms) for persisting the "remember last view" snapshot. */
const LAST_VIEW_WRITE_DELAY = 600

/**
 * One-shot hydration of the ephemeral skills store from persisted preferences,
 * plus optional write-back of the last view.
 *
 * - Waits until settings are `loaded`, then seeds the store exactly once
 *   (ref-guarded) with the default tab / sort / status filter — or, when
 *   `rememberLastView` is on and a snapshot exists, restores the last tab and
 *   non-query filters instead.
 * - While `rememberLastView` is on, subscribes to store changes and persists a
 *   debounced snapshot (tab + non-query filters). The search query is never
 *   persisted. A per-snapshot dedupe ref avoids redundant `saveSettings`
 *   writes (including the echo from hydration itself).
 */
export function useSkillPrefsHydration(): void {
  const loaded = useSettingsStore((s) => s.loaded)
  const rawPrefs = useSettingsStore((s) => s.settings?.skillPanelPrefs)
  const rawLastView = useSettingsStore((s) => s.settings?.lastSkillView)
  const setLastSkillView = useSettingsStore((s) => s.setLastSkillView)

  const prefs = useMemo(() => resolveSkillPanelPrefs(rawPrefs), [rawPrefs])
  const hydratedRef = useRef(false)
  const lastWrittenRef = useRef<string>("")

  // --- Hydrate once, after settings load ---
  useEffect(() => {
    if (!loaded || hydratedRef.current) return
    hydratedRef.current = true

    let lastView: LastSkillView | null = null
    if (prefs.rememberLastView && rawLastView) {
      lastView = {
        tab: rawLastView.tab ?? prefs.defaultTab,
        sort: rawLastView.sort ?? prefs.defaultSort,
        category: rawLastView.category ?? "all",
        source: rawLastView.source ?? "all",
        status: rawLastView.status ?? prefs.defaultStatusFilter,
        tag: rawLastView.tag ?? null,
      }
    }
    // Seed the dedupe key so the store `set` from hydration doesn't echo back
    // an immediate write.
    lastWrittenRef.current = JSON.stringify(snapshotFor(lastView, prefs))
    useSkillsStore.getState().hydrateFromPrefs(prefs, lastView)
  }, [loaded, prefs, rawLastView])

  // --- Persist the last view (debounced) while the toggle is on ---
  useEffect(() => {
    if (!prefs.rememberLastView) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      const { activeTab, filters } = useSkillsStore.getState()
      const snap = {
        tab: activeTab,
        sort: filters.sort,
        category: filters.category,
        source: filters.source,
        status: filters.status,
        tag: filters.tag,
      }
      const key = JSON.stringify(snap)
      if (key === lastWrittenRef.current) return
      lastWrittenRef.current = key
      void setLastSkillView(snap)
    }
    const unsub = useSkillsStore.subscribe(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, LAST_VIEW_WRITE_DELAY)
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsub()
    }
  }, [prefs.rememberLastView, setLastSkillView])
}

/**
 * Build the snapshot key used for dedupe — from a restored last view when
 * present, else from the prefs defaults (matching what `hydrateFromPrefs`
 * writes into the store).
 */
function snapshotFor(lastView: LastSkillView | null, prefs: SkillPanelPrefs) {
  if (lastView) {
    return {
      tab: lastView.tab,
      sort: lastView.sort,
      category: lastView.category,
      source: lastView.source,
      status: lastView.status,
      tag: lastView.tag,
    }
  }
  return {
    tab: prefs.defaultTab,
    sort: prefs.defaultSort,
    category: "all",
    source: "all",
    status: prefs.defaultStatusFilter,
    tag: null,
  }
}
