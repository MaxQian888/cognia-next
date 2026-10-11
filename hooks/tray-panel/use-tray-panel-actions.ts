"use client"

/**
 * The tray panel's action catalogue for the main window's settings editor
 * (ADR-0225 §10): read from `AppSettings.trayPanelActions` through
 * `resolveTrayPanelActions`, written back whole. The panel window never uses
 * this; it renders the catalogue the glance snapshot carries, which follows
 * every write here.
 */

import { useCallback, useMemo } from "react"

import {
  moveAction,
  removeAction,
  resolveTrayPanelActions,
  upsertAction,
} from "@/lib/tray-panel/catalogue"
import { DEFAULT_TRAY_PANEL_ACTIONS } from "@/lib/tray-panel/defaults"
import type { TrayPanelAction } from "@/lib/tray-panel/types"
import { useSettingsStore } from "@/stores/settings"

export interface UseTrayPanelActionsResult {
  actions: TrayPanelAction[]
  setActions: (next: TrayPanelAction[]) => Promise<void>
  upsert: (action: TrayPanelAction) => Promise<void>
  remove: (id: string) => Promise<void>
  move: (id: string, direction: -1 | 1) => Promise<void>
  /** Back to the shipped catalogue. */
  reset: () => Promise<void>
}

export function useTrayPanelActions(): UseTrayPanelActionsResult {
  const stored = useSettingsStore((s) => s.settings?.trayPanelActions)
  const save = useSettingsStore((s) => s.save)
  const actions = useMemo(() => resolveTrayPanelActions(stored), [stored])

  const setActions = useCallback(
    (next: TrayPanelAction[]) => save({ trayPanelActions: next }),
    [save]
  )
  const upsert = useCallback(
    (action: TrayPanelAction) => setActions(upsertAction(actions, action)),
    [actions, setActions]
  )
  const remove = useCallback(
    (id: string) => setActions(removeAction(actions, id)),
    [actions, setActions]
  )
  const move = useCallback(
    (id: string, direction: -1 | 1) => setActions(moveAction(actions, id, direction)),
    [actions, setActions]
  )
  const reset = useCallback(() => setActions(DEFAULT_TRAY_PANEL_ACTIONS), [setActions])

  return { actions, setActions, upsert, remove, move, reset }
}
