"use client"

/**
 * Surface-filtered live view of the plugin quick-action registry.
 *
 * Subscribes via `useSyncExternalStore` (the registry keeps an
 * identity-stable snapshot) and applies each action's `when` expression
 * against the live tray state snapshot — the same evaluator + state the
 * tray menu uses, so visibility behaves identically across surfaces.
 */

import { useMemo, useSyncExternalStore } from "react"
import type { PluginQuickActionSurface } from "@/types/plugin"
import {
  getQuickActionSnapshot,
  subscribeQuickActions,
  type QuickActionEntry,
} from "@/lib/plugin/registries/quick-action-registry"
import { evaluateWhen } from "@/lib/tray/when"
import { useTrayStateSnapshot } from "@/lib/tray/state-snapshot"
import type { TrayStateSnapshot } from "@/lib/tray/types"

function safeWhen(expr: string | undefined, snapshot: TrayStateSnapshot): boolean {
  try {
    return evaluateWhen(expr, snapshot)
  } catch {
    // Malformed `when` expression — hide the item (matches the tray's
    // "menu still renders, dependent item hidden" semantics).
    return false
  }
}

export function usePluginQuickActions(surface: PluginQuickActionSurface): QuickActionEntry[] {
  const all = useSyncExternalStore(
    subscribeQuickActions,
    getQuickActionSnapshot,
    getQuickActionSnapshot
  )
  const snapshot = useTrayStateSnapshot()
  return useMemo(
    () => all.filter((a) => a.surfaces.includes(surface) && safeWhen(a.when, snapshot)),
    [all, surface, snapshot]
  )
}
