"use client"

/**
 * Reactive source of plugin-contributed slash commands for the chat composer's
 * `/` picker. The unified registry (`lib/slash-commands/registry.ts`) holds
 * every plugin command, but the composer historically only read
 * `BUILTIN_SLASH_COMMANDS` + custom `.md` — so plugin commands were registered
 * yet never surfaced in chat. This hook bridges that gap.
 *
 * The registry is a bare Map, so we subscribe via `useSyncExternalStore` to its
 * version counter and re-derive the projected `SlashCommand[]` only when the
 * registry actually changes (a plugin enabling/disabling adds/removes commands).
 */

import { useMemo, useSyncExternalStore } from "react"

import type { SlashCommand } from "@/lib/slash-commands/builtin"
import { getPluginSlashCommands } from "@/lib/slash-commands/plugin-commands"
import { getSlashCommandsVersion, subscribeSlashCommands } from "@/lib/slash-commands/registry"

export function usePluginSlashCommands(): SlashCommand[] {
  const version = useSyncExternalStore(
    subscribeSlashCommands,
    getSlashCommandsVersion,
    // Server snapshot: the registry is empty during SSR/static export.
    getSlashCommandsVersion
  )
  // `version` is the change signal: it isn't read inside, but re-deriving the
  // projection when the registry mutates is the whole point.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => getPluginSlashCommands(), [version])
}
