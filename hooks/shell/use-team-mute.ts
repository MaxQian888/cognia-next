"use client"

/**
 * Read and write the muted-team set (`conversationSidebar.mutedTeamIds`), and
 * the unread aggregate with it applied.
 *
 * `useVisibleGuildUnread` is what the navigation's badges read: the rail's
 * team buttons, the compact guild band and the app/dock badge. It is the
 * shared `useGuildUnread` aggregate with `applyGuildMute`
 * (`lib/shell/guild-mute.ts`) on top, so a muted team drops out of every one
 * of them at once.
 *
 * The writer goes through the team-preference queue in
 * `use-ordered-teams.ts`: `conversationSidebar` is replaced whole on every
 * save, and a mute landing next to a team drag must not erase it.
 */

import { useCallback, useMemo } from "react"
import { useShallow } from "zustand/react/shallow"

import { useGuildUnread, type GuildUnread } from "@/hooks/shell/use-guild-unread"
import { enqueueTeamPrefsWrite } from "@/hooks/shell/use-ordered-teams"
import { applyGuildMute, mutedTeamSet, withTeamMuted } from "@/lib/shell/guild-mute"
import { useSettingsStore } from "@/stores/settings/settings-store"

const NONE: readonly string[] = []

/** Muted team ids as a set. Re-renders only when the list's contents change. */
export function useMutedTeamIds(): ReadonlySet<string> {
  const stored = useSettingsStore(
    useShallow((s) => s.settings?.conversationSidebar?.mutedTeamIds ?? NONE)
  )
  return useMemo(() => mutedTeamSet(stored), [stored])
}

/** Mute (`true`) or unmute (`false`) one team's badges. */
export function setTeamMuted(teamId: string, muted: boolean): Promise<void> {
  return enqueueTeamPrefsWrite((current) => ({
    mutedTeamIds: withTeamMuted(current?.mutedTeamIds, teamId, muted),
  }))
}

export interface UseTeamMute {
  muted: ReadonlySet<string>
  isMuted: (teamId: string) => boolean
  setMuted: (teamId: string, muted: boolean) => Promise<void>
}

export function useTeamMute(): UseTeamMute {
  const muted = useMutedTeamIds()
  const isMuted = useCallback((teamId: string) => muted.has(teamId), [muted])
  return { muted, isMuted, setMuted: setTeamMuted }
}

/** `useGuildUnread` without the muted teams — what every badge draws. */
export function useVisibleGuildUnread(): GuildUnread {
  const unread = useGuildUnread()
  const muted = useMutedTeamIds()
  return useMemo(() => applyGuildMute(unread, muted), [unread, muted])
}
