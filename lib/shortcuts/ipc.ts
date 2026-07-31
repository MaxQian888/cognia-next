"use client"

/**
 * The raw `shortcut_list` call, with no store attached.
 *
 * `useShortcutStore` is the normal way to read bindings, but it is a zustand
 * store that also hydrates prefs — too much for the selection-toolbar overlay,
 * which mounts a minimal shell (`components/pet/pet-window-shell.tsx`) and never
 * hydrates the app-wide stores. Both callers went through this one command with
 * their own inline copy of its shape; this is that shape, declared once.
 */

import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/tauri"
import type { Chord } from "./types"

/** One row of `shortcut_list` — mirrors `ShortcutRegistry::list` in `registry.rs`. */
export interface GlobalShortcutBinding {
  id: string
  chord: Chord
}

/**
 * Named because the selection-toolbar overlay grants this command explicitly in
 * its own capability — see `OVERLAY_COMMANDS` in `lib/tauri/selection-toolbar.ts`.
 */
export const SHORTCUT_LIST_COMMAND = "shortcut_list"

/** Every currently bound global shortcut. Empty off the desktop app. */
export async function listGlobalShortcuts(): Promise<GlobalShortcutBinding[]> {
  if (!isTauri()) return []
  return (await invoke<GlobalShortcutBinding[]>(SHORTCUT_LIST_COMMAND)) ?? []
}

/** The same list keyed by id, which is how both callers actually consume it. */
export async function getGlobalShortcutChords(): Promise<Record<string, Chord>> {
  const bindings = await listGlobalShortcuts()
  return Object.fromEntries(bindings.map((binding) => [binding.id, binding.chord]))
}
