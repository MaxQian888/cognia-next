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
import { useClientLiveQuery } from "@/hooks/data"
import { getDb } from "@/lib/db/schema"
import { listSessionStates, markSessionRead } from "@/lib/db/session-state"
import { resolveConversationGroupBy } from "@/lib/chat/conversation-grouping"
import {
  needsCrossWorkspaceSessions,
  resolveConversationSearchOptions,
} from "@/lib/chat/conversation-search-scope"
import { isSessionExposed } from "@/lib/chat/session-exposure"
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
 * beside. `workspace` with a null `projectId` is the list before the project
 * store has loaded, which shows nothing, so the badges show nothing either.
 */
export type GuildUnreadScope =
  { kind: "all-workspaces" } | { kind: "workspace"; projectId: string | null }

/** Every workspace — the reach of a list grouped by, or searching across, workspaces. */
export const ALL_WORKSPACES_SCOPE: GuildUnreadScope = { kind: "all-workspaces" }

/**
 * Whether `session` is in the list `scope` describes. Mirrors
 * `listWorkspaceSessions`: the workspace's own conversations plus those of no
 * workspace (a paired client's host-synced history, pre-workspace chats).
 */
export function isInGuildUnreadScope(
  session: Pick<ChatSession, "projectId">,
  scope: GuildUnreadScope
): boolean {
  if (scope.kind === "all-workspaces") return true
  if (scope.projectId == null) return false
  return !session.projectId || session.projectId === scope.projectId
}

/**
 * Pure aggregation: one unread conversation counts once, under the guild the
 * main list files it in. Archived conversations and sessions the main list
 * never shows (embedded / subagent transcripts) are excluded — the badge must
 * never promise something the open section cannot show.
 */
export function aggregateGuildUnread(
  sessions: ReadonlyArray<UnreadSession | undefined>,
  unreadBySession: ReadonlyMap<string, number>,
  scope: GuildUnreadScope = ALL_WORKSPACES_SCOPE
): GuildUnread {
  let dm = 0
  const teams = new Map<string, number>()
  for (const session of sessions) {
    if (!session) continue
    if (!unreadBySession.has(session.id)) continue
    if (session.archivedAt != null) continue
    if (!isSessionExposed(session, "main-list")) continue
    if (!isInGuildUnreadScope(session, scope)) continue
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
export async function loadGuildUnread(scope: GuildUnreadScope): Promise<GuildUnread> {
  if (scope.kind === "workspace" && scope.projectId == null) return EMPTY_GUILD_UNREAD
  const states = await listSessionStates()
  const unreadBySession = new Map<string, number>()
  for (const state of states) {
    if (state.unreadCount > 0) unreadBySession.set(state.sessionId, state.unreadCount)
  }
  if (unreadBySession.size === 0) return EMPTY_GUILD_UNREAD
  const sessions = await getDb().sessions.bulkGet([...unreadBySession.keys()])
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
  if (scope.kind === "workspace" && scope.projectId == null) return 0
  const states = await listSessionStates()
  const unreadIds = states.filter((s) => s.unreadCount > 0).map((s) => s.sessionId)
  if (unreadIds.length === 0) return 0
  const sessions = await getDb().sessions.bulkGet(unreadIds)
  const targets = sessions.filter((session): session is ChatSession => {
    if (!session) return false
    if (session.archivedAt != null) return false
    if (!isSessionExposed(session, "main-list")) return false
    if (!isInGuildUnreadScope(session, scope)) return false
    const inTeam = session.kind === "team" && Boolean(session.teamId)
    return target.kind === "team" ? inTeam && session.teamId === target.teamId : !inTeam
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

export function useGuildUnread(): GuildUnread {
  const showUnreadBadges = useSettingsStore(
    (s) => s.settings?.conversationSidebar?.showUnreadBadges ?? true
  )
  const scope = useGuildUnreadScope()
  const live = useClientLiveQuery<GuildUnread>(
    () => loadGuildUnread(scope),
    [scope],
    EMPTY_GUILD_UNREAD
  )
  return useMemo(
    () => (showUnreadBadges ? (live ?? EMPTY_GUILD_UNREAD) : EMPTY_GUILD_UNREAD),
    [showUnreadBadges, live]
  )
}
