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
 * The read and the "may this count?" filter are shared with the mobile badges
 * (`lib/chat/unread-sessions.ts`): unread pointers first, then *only* the
 * sessions they name, observed by one Dexie live query per window however
 * many badges draw from it.
 *
 * Honours `conversationSidebar.showUnreadBadges` — hiding a badge is a display
 * choice, and this is a badge, so it goes dark with the rest.
 *
 * Workspace-scoped like the list it summarizes (`useSessions` loads
 * `listWorkspaceSessions(activeProjectId)` — the active workspace plus the
 * conversations of no workspace — unless the grouping or the search reach
 * needs every workspace). Counting every workspace here badged conversations
 * the open section could not show, and the badge's "mark all read" cleared
 * other workspaces' unread state behind the user's back.
 */

import { useMemo } from "react"
import type { ChatSession } from "@cognia/agent-config-types"
import { useUnreadSessions } from "@/hooks/shell/use-unread-sessions"
import { markSessionRead } from "@/lib/db/session-state"
import { resolveConversationGroupBy } from "@/lib/chat/conversation-grouping"
import {
  needsCrossWorkspaceSessions,
  resolveConversationSearchOptions,
} from "@/lib/chat/conversation-search-scope"
import {
  ALL_WORKSPACES_UNREAD_SCOPE,
  isBadgeableUnread,
  isInUnreadScope,
  isUnreadScopeOpen,
  loadUnreadSessions,
  unreadGuildTeamId,
  type UnreadScope,
} from "@/lib/chat/unread-sessions"
import { useProjectStore } from "@/stores/project/project-store"
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

/** The session fields the badge actually reads. Exported so a test fixture can
 * speak the same vocabulary instead of widening `kind` to `string`. */
export type UnreadSession = Pick<
  ChatSession,
  "id" | "kind" | "teamId" | "archivedAt" | "visibility" | "projectId"
>

/**
 * Which conversations the badges may count — the reach of the list they sit
 * beside. The definition lives with the shared filter in
 * `lib/chat/unread-sessions.ts`; these names are the shell's vocabulary for it.
 */
export type GuildUnreadScope = UnreadScope

/** Every workspace — the reach of a list grouped by, or searching across, workspaces. */
export const ALL_WORKSPACES_SCOPE: GuildUnreadScope = ALL_WORKSPACES_UNREAD_SCOPE

/** Whether `session` is in the list `scope` describes (see `isInUnreadScope`). */
export const isInGuildUnreadScope = isInUnreadScope

/**
 * Pure aggregation: one unread conversation counts once, under the guild the
 * main list files it in. What may count at all is the shared
 * `isBadgeableUnread` filter — the badge must never promise something the open
 * section cannot show.
 */
export function aggregateGuildUnread(
  sessions: ReadonlyArray<UnreadSession | undefined>,
  unreadBySession: ReadonlyMap<string, number>,
  scope: GuildUnreadScope = ALL_WORKSPACES_SCOPE
): GuildUnread {
  let dm = 0
  const teams = new Map<string, number>()
  for (const session of sessions) {
    if (!session || !unreadBySession.has(session.id)) continue
    if (!isBadgeableUnread(session, scope)) continue
    const teamId = unreadGuildTeamId(session)
    if (teamId) {
      teams.set(teamId, (teams.get(teamId) ?? 0) + 1)
    } else {
      dm += 1
    }
  }
  let total = dm
  for (const count of teams.values()) total += count
  return { dm, teams, total }
}

/** Resolves the aggregate from Dexie through the shared unread read. */
export async function loadGuildUnread(scope: GuildUnreadScope): Promise<GuildUnread> {
  if (!isUnreadScopeOpen(scope)) return EMPTY_GUILD_UNREAD
  const { sessions, unreadBySession } = await loadUnreadSessions()
  if (unreadBySession.size === 0) return EMPTY_GUILD_UNREAD
  return aggregateGuildUnread(sessions, unreadBySession, scope)
}

export type GuildUnreadTarget = { kind: "dm" } | { kind: "team"; teamId: string }

/**
 * Clear the unread state of every conversation the badge for `target` counts
 * — the badge's own "mark all as read". Returns how many were cleared. Same
 * filter as the aggregate, so what the badge showed is exactly what clears.
 */
export async function markGuildRead(
  target: GuildUnreadTarget,
  scope: GuildUnreadScope
): Promise<number> {
  if (!isUnreadScopeOpen(scope)) return 0
  const { sessions, unreadBySession } = await loadUnreadSessions()
  if (unreadBySession.size === 0) return 0
  const targets = sessions.filter((session) => {
    if (!unreadBySession.has(session.id)) return false
    if (!isBadgeableUnread(session, scope)) return false
    const teamId = unreadGuildTeamId(session)
    return target.kind === "team" ? teamId === target.teamId : teamId === null
  })
  await Promise.all(targets.map((session) => markSessionRead(session.id)))
  return targets.length
}

/**
 * The reach the badges share with the conversation list. Derived from the same
 * inputs `DesktopChatWorkspace` / `AppShellMobile` hand `useSessions`: the
 * stored grouping and search reach, over the active workspace.
 *
 * The stored grouping is the right input exactly where these badges render.
 * The icon column and the compact guild band are on screen only while the list
 * is NOT the merged desktop rail, and outside the merged rail the list groups
 * by the stored preference. The merged rail itself groups on the team axis and
 * counts its scope headers from its own rows (`channel-list.tsx`), passing its
 * reach to `GuildScopeMenuItems` explicitly.
 */
export function useGuildUnreadScope(): GuildUnreadScope {
  const sidebar = useSettingsStore((s) => s.settings?.conversationSidebar)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const projectStoreLoaded = useProjectStore((s) => s.loaded)
  const crossWorkspace = needsCrossWorkspaceSessions(
    resolveConversationGroupBy(sidebar),
    resolveConversationSearchOptions(sidebar)
  )
  const projectId = projectStoreLoaded ? (activeProjectId ?? null) : null
  return useMemo<GuildUnreadScope>(
    () => (crossWorkspace ? ALL_WORKSPACES_SCOPE : { kind: "workspace", projectId }),
    [crossWorkspace, projectId]
  )
}

/**
 * The guild aggregate for the shared scope. Reads the window's one unread
 * observer (`useUnreadSessions`), so the rail, the compact guild band and the
 * app badge cost one Dexie live query between them; the scope and the
 * display setting are applied here, reader-side.
 */
export function useGuildUnread(): GuildUnread {
  const showUnreadBadges = useSettingsStore(
    (s) => s.settings?.conversationSidebar?.showUnreadBadges ?? true
  )
  const scope = useGuildUnreadScope()
  const unread = useUnreadSessions()
  return useMemo(() => {
    if (!showUnreadBadges || !unread || !isUnreadScopeOpen(scope)) return EMPTY_GUILD_UNREAD
    if (unread.unreadBySession.size === 0) return EMPTY_GUILD_UNREAD
    return aggregateGuildUnread(unread.sessions, unread.unreadBySession, scope)
  }, [showUnreadBadges, unread, scope])
}
