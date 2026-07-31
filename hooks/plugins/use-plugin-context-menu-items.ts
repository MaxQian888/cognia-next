"use client"

/**
 * Zone-filtered live view of plugin-contributed context-menu items, plus
 * the click dispatcher.
 *
 * `firePluginContextMenuItem` dispatches the `plugin-context-menu:<id>`
 * CustomEvent rather than calling `onClick` directly — that's the contract
 * `ctx.contextMenu.register` listeners were written against
 * (lib/plugin/core/context.ts), and it keeps a future Rust-driven menu
 * renderer wire-compatible.
 */

import { useMemo, useSyncExternalStore } from "react"
import type { ContextMenuClickContext, ContextMenuContext } from "@/types/plugin"
import {
  getContextMenuSnapshot,
  subscribeContextMenuItems,
  type PluginContextMenuEntry,
} from "@/lib/plugin/context-menu/registry"

function targetsZone(entry: PluginContextMenuEntry, zone: ContextMenuContext): boolean {
  const when = entry.item.when
  if (!when) return true
  return Array.isArray(when) ? when.includes(zone) : when === zone
}

export function usePluginContextMenuItems(zone: ContextMenuContext): PluginContextMenuEntry[] {
  const all = useSyncExternalStore(
    subscribeContextMenuItems,
    getContextMenuSnapshot,
    getContextMenuSnapshot
  )
  return useMemo(() => all.filter((entry) => targetsZone(entry, zone)), [all, zone])
}

/** Resolve the (possibly functional) disabled flag for a click context. */
export function isContextMenuItemDisabled(
  entry: PluginContextMenuEntry,
  context: ContextMenuClickContext
): boolean {
  const disabled = entry.item.disabled
  if (typeof disabled === "function") {
    try {
      return disabled(context)
    } catch {
      return true
    }
  }
  return disabled ?? false
}

/**
 * Dispatch a plugin context-menu click. No-ops when the item resolves as
 * disabled for this context.
 */
export function firePluginContextMenuItem(
  entry: PluginContextMenuEntry,
  context: ContextMenuClickContext
): void {
  if (isContextMenuItemDisabled(entry, context)) return
  window.dispatchEvent(
    new CustomEvent<ContextMenuClickContext>(`plugin-context-menu:${entry.id}`, {
      detail: context,
    })
  )
}
