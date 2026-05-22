"use client"

// Detail-pane helper: wraps `getPlugin(id)` with a discriminated state so
// callers can distinguish "still loading from Dexie" from "no plugin with
// that id exists" without falling back to undefined-as-both. The plain
// `useLiveQuery(getPlugin)` call returns `undefined` for both cases, which
// makes the difference between a brief loading flash and a true 404
// invisible — and forces the detail surfaces to render "notFound" text
// during normal navigation.

import { useLiveQuery } from "dexie-react-hooks"
import { getPlugin } from "@/lib/db/plugins"
import type { PluginRow } from "@/lib/db/plugin-types"

// Sentinel object — useLiveQuery returns its third argument verbatim until
// the underlying promise resolves. Comparing by reference distinguishes the
// pre-resolution state from a resolved-but-empty (undefined) state.
const LOADING_SENTINEL = { __pluginRowLoading: true } as const

export type PluginRowState =
  | { state: "loading" }
  | { state: "not-found" }
  | { state: "ready"; row: PluginRow }

export function usePluginRow(pluginId: string): PluginRowState {
  const result = useLiveQuery<PluginRow | undefined | typeof LOADING_SENTINEL>(
    () => getPlugin(pluginId),
    [pluginId],
    LOADING_SENTINEL
  )
  if (result === LOADING_SENTINEL) return { state: "loading" }
  if (result === undefined) return { state: "not-found" }
  return { state: "ready", row: result }
}
