"use client"

/**
 * Unread conversations per chat guild — Direct Messages and each team — for
 * the shell's guild switchers.
 *
 * The conversation list shows a per-row unread badge; the rows of a *closed*
 * accordion section (`sidebar-guild-sections.tsx`) and the icon column's team
 * buttons (`guild-rail.tsx`) hide those rows entirely, so without this a team
 * that has unread conversations looks exactly like one that has none. Both
 * surfaces read the same aggregate: how many unread conversations each guild
 * holds, counting only what the main list would show (exposed, not archived).
 *
 * Reads the unread table first and resolves *only* the sessions it names, so
 * a large history costs nothing beyond the handful of rows with unread. Live:
 * Dexie re-runs the query when either table changes.
 *
 * Honours `conversationSidebar.showUnreadBadges` — hiding a badge is a display
 * choice, and this is a badge, so it goes dark with the rest.
 */

import { useMemo } from "react"
import type { ChatSession } from "@cognia/agent-config-types"
import { useClientLiveQuery } from "@/hooks/data"
import { getDb } from "@/lib/db/schema"
import { listSessionStates, markSessionRead } from "@/lib/db/session-state"
import { isSessionExposed } from "@/lib/chat/session-exposure"
import { useSettingsStore } from "@/stores/settings"

export interface GuildUnread {
  /** Unread conversations in the Direct Messages guild (anything not a team). */
  dm: number
  /** Unread conversations per team id; teams with none are absent. */
  teams: ReadonlyMap<string, number>
  /** Sum over every guild. */
  total: number
}

const EMPTY_GUILD_UNREAD: GuildUnread = { dm: 0, teams: new Map(), total: 0 }

type UnreadSession = Pick<ChatSession, "id" | "kind" | "teamId" | "archivedAt" | "visibility">

/**
 * Pure aggregation: one unread conversation counts once, under the guild the
 * main list files it in. Archived conversations and sessions the main list
 * never shows (embedded / subagent transcripts) are excluded — the badge must
 * never promise something the open section cannot show.
 */
export function aggregateGuildUnread(
  sessions: ReadonlyArray<UnreadSession | undefined>,
  unreadBySession: ReadonlyMap<string, number>
): GuildUnread {
  let dm = 0
  const teams = new Map<string, number>()
  for (const session of sessions) {
    if (!session) continue
    if (!unreadBySession.has(session.id)) continue
    if (session.archivedAt != null) continue
    if (!isSessionExposed(session, "main-list")) continue
    if (session.kind === "team" && session.teamId) {
      teams.set(session.teamId, (teams.get(session.teamId) ?? 0) + 1)
    } else {
      dm += 1
    }
  }
  let total = dm
  for (const count of teams.values()) total += count
  return { dm, teams, total }
}

/** Resolves the aggregate from Dexie: unread rows first, then just their sessions. */
export async function loadGuildUnread(): Promise<GuildUnread> {
  const states = await listSessionStates()
  const unreadBySession = new Map<string, number>()
  for (const state of states) {
    if (state.unreadCount > 0) unreadBySession.set(state.sessionId, state.unreadCount)
  }
  if (unreadBySession.size === 0) return EMPTY_GUILD_UNREAD
  const sessions = await getDb().sessions.bulkGet([...unreadBySession.keys()])
  return aggregateGuildUnread(sessions, unreadBySession)
}

export type GuildUnreadTarget = { kind: "dm" } | { kind: "team"; teamId: string }

/**
 * Clear the unread state of every conversation the badge for `target` counts
 * — the badge's own "mark all as read". Returns how many were cleared. Same
 * filter as the aggregate, so what the badge showed is exactly what clears.
 */
export async function markGuildRead(target: GuildUnreadTarget): Promise<number> {
  const states = await listSessionStates()
  const unreadIds = states.filter((s) => s.unreadCount > 0).map((s) => s.sessionId)
  if (unreadIds.length === 0) return 0
  const sessions = await getDb().sessions.bulkGet(unreadIds)
  const targets = sessions.filter((session): session is ChatSession => {
    if (!session) return false
    if (session.archivedAt != null) return false
    if (!isSessionExposed(session, "main-list")) return false
    const inTeam = session.kind === "team" && Boolean(session.teamId)
    return target.kind === "team" ? inTeam && session.teamId === target.teamId : !inTeam
  })
  await Promise.all(targets.map((session) => markSessionRead(session.id)))
  return targets.length
}

export function useGuildUnread(): GuildUnread {
  const showUnreadBadges = useSettingsStore(
    (s) => s.settings?.conversationSidebar?.showUnreadBadges ?? true
  )
  const live = useClientLiveQuery<GuildUnread>(loadGuildUnread, [], EMPTY_GUILD_UNREAD)
  return useMemo(
    () => (showUnreadBadges ? (live ?? EMPTY_GUILD_UNREAD) : EMPTY_GUILD_UNREAD),
    [showUnreadBadges, live]
  )
}
