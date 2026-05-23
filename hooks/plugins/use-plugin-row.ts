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
// pre-resolution state from a resolved-but-empty (undefined) state. The
// nominal `__pluginRowLoading` field lets us narrow with `"… in result"`
// since reference-equality with an `as const` sentinel doesn't narrow.
const LOADING_SENTINEL = { __pluginRowLoading: true } as const
type LoadingSentinel = typeof LOADING_SENTINEL

function isLoadingSentinel(x: PluginRow | undefined | LoadingSentinel): x is LoadingSentinel {
  return x !== undefined && "__pluginRowLoading" in x
}

export type PluginRowState =
  | { state: "loading" }
  | { state: "not-found" }
  | { state: "ready"; row: PluginRow }

export function usePluginRow(pluginId: string): PluginRowState {
  const result = useLiveQuery<PluginRow | undefined, LoadingSentinel>(
    () => getPlugin(pluginId),
    [pluginId],
    LOADING_SENTINEL
  )
  if (isLoadingSentinel(result)) return { state: "loading" }
  if (result === undefined) return { state: "not-found" }
  return { state: "ready", row: result }
}
