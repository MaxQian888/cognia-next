/**
 * The one definition of "which conversations are unread, and which of them a
 * badge may count", plus the one live read of it per window.
 *
 * Every unread number the shells draw derives from here:
 *
 *   - the desktop guild badges and the app/dock badge
 *     (`hooks/shell/use-guild-unread.ts` → `aggregateGuildUnread`);
 *   - the badge's own "mark all as read" (`markGuildRead`), which must clear
 *     exactly what the badge counted;
 *   - the mobile Chat tab badge, the Inbox dot and the installed-PWA icon
 *     (`lib/inbox/unread-count.ts` → `countMobileUnread`).
 *
 * They used to repeat both the Dexie read (unread pointers → the sessions they
 * name) and the filter (resolved, not archived, on the main list, in reach),
 * and each call site ran its own Dexie live query of it — three on a desktop
 * window, three on a phone. Two copies of "unread" drift; one cannot.
 *
 * The source is `sessionState` (it syncs to paired devices). Only the pointers
 * with `unreadCount > 0` are resolved, so a long history costs nothing beyond
 * the handful of rows that actually have unread. A pointer whose session is
 * gone resolves to nothing and is skipped, which is why `sessionState` needs no
 * tombstones of its own.
 *
 * The live read is a module-level store with the `useSyncExternalStore`
 * contract, refcounted like `hooks/inbox/use-im-configured.ts`: the Dexie
 * `liveQuery` starts with the first subscriber and stops with the last. It is
 * NOT keyed by workspace scope: the read itself is scope-free, and the scope
 * is a pure filter each reader applies (`isBadgeableUnread`), so every scope a
 * window asks for shares one observer.
 */

import Dexie from "dexie"
import type { ChatSession } from "@cognia/agent-config-types"
import { loggers } from "@cognia/logging"

import { isSessionExposed } from "@/lib/chat/session-exposure"
import { getDb } from "@/lib/db/schema"
import { listSessionStates } from "@/lib/db/session-state"

const log = loggers.chat

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Which conversations a badge may count — the reach of the list it sits
 * beside. `workspace` with a null `projectId` is the list before the project
 * store has loaded, which shows nothing, so the badges show nothing either.
 */
export type UnreadScope =
  { kind: "all-workspaces" } | { kind: "workspace"; projectId: string | null }

/** Every workspace — the reach of a list grouped by, or searching across, workspaces. */
export const ALL_WORKSPACES_UNREAD_SCOPE: UnreadScope = Object.freeze({ kind: "all-workspaces" })

/**
 * Whether `session` is in the list `scope` describes. Mirrors
 * `listWorkspaceSessions`: the workspace's own conversations plus those of no
 * workspace (a paired client's host-synced history, pre-workspace chats).
 */
export function isInUnreadScope(
  session: Pick<ChatSession, "projectId">,
  scope: UnreadScope
): boolean {
  if (scope.kind === "all-workspaces") return true
  if (scope.projectId == null) return false
  return !session.projectId || session.projectId === scope.projectId
}

/** Whether `scope` can admit anything at all (it cannot before the workspace is known). */
export function isUnreadScopeOpen(scope: UnreadScope): boolean {
  return scope.kind === "all-workspaces" || scope.projectId != null
}

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------

/** The session fields `isBadgeableUnread` reads. */
export type BadgeableSessionFields = Pick<
  ChatSession,
  "archivedAt" | "kind" | "visibility" | "projectId"
>

/**
 * Whether an unread conversation may contribute to a badge.
 *
 * A badge promises something tappable, so it never counts what the list it
 * summarizes cannot show: a session that no longer resolves, an archived
 * conversation, a transcript the main list never lists (embedded / subagent),
 * or a conversation outside the list's workspace reach.
 *
 * Whether the conversation is unread at all is the caller's input (the
 * `unreadBySession` map `loadUnreadSessions` returns), not this filter's.
 */
export function isBadgeableUnread<S extends BadgeableSessionFields>(
  session: S | undefined | null,
  scope: UnreadScope = ALL_WORKSPACES_UNREAD_SCOPE
): session is S {
  if (!session) return false
  if (session.archivedAt != null) return false
  if (!isSessionExposed(session, "main-list")) return false
  return isInUnreadScope(session, scope)
}

/**
 * The team a conversation is filed under in the guild switchers, or `null`
 * for the Direct Messages guild. A team conversation with no `teamId` has no
 * team to be filed under and reads as a direct one.
 */
export function unreadGuildTeamId(session: Pick<ChatSession, "kind" | "teamId">): string | null {
  return session.kind === "team" && session.teamId ? session.teamId : null
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/**
 * Every field any unread badge reads. The live snapshot holds sessions
 * projected to exactly these, so a write to anything else on an unread
 * session (a streamed reply bumping `updatedAt`, a title) does not wake every
 * badge in the window.
 */
const BADGE_FIELDS = [
  "id",
  "kind",
  "teamId",
  "archivedAt",
  "visibility",
  "projectId",
  "platformBinding",
  "platformConversationKey",
  "integrationBinding",
] as const satisfies ReadonlyArray<keyof ChatSession>

/** An unread conversation, projected to the fields the badges read. */
export type UnreadBadgeSession = Pick<ChatSession, (typeof BADGE_FIELDS)[number]>

export interface UnreadSessions {
  /** The unread conversations that still resolve, projected to the badge fields. */
  readonly sessions: ReadonlyArray<UnreadBadgeSession>
  /** Unread message count per session id, for every pointer with unread. */
  readonly unreadBySession: ReadonlyMap<string, number>
}

export const EMPTY_UNREAD_SESSIONS: UnreadSessions = Object.freeze({
  sessions: Object.freeze([]) as ReadonlyArray<UnreadBadgeSession>,
  unreadBySession: new Map<string, number>(),
})

function projectBadgeSession(session: ChatSession): UnreadBadgeSession {
  const projected: Partial<Record<(typeof BADGE_FIELDS)[number], unknown>> = {}
  for (const field of BADGE_FIELDS) {
    if (session[field] !== undefined) projected[field] = session[field]
  }
  return projected as UnreadBadgeSession
}

/**
 * Resolve the unread conversations from Dexie: the unread pointers first, then
 * only the sessions they name.
 */
export async function loadUnreadSessions(): Promise<UnreadSessions> {
  const states = await listSessionStates()
  const unreadBySession = new Map<string, number>()
  for (const state of states) {
    if (state.unreadCount > 0) unreadBySession.set(state.sessionId, state.unreadCount)
  }
  if (unreadBySession.size === 0) return EMPTY_UNREAD_SESSIONS
  const rows = await getDb().sessions.bulkGet([...unreadBySession.keys()])
  const sessions: UnreadBadgeSession[] = []
  for (const row of rows) {
    if (row) sessions.push(projectBadgeSession(row))
  }
  return { sessions, unreadBySession }
}

function sameFieldValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  // The IM bindings are small plain objects; every Dexie read hands back a
  // fresh copy, so identity says nothing about them.
  if (a && b && typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}

/** Whether two reads would draw the same badges. */
export function sameUnreadSessions(a: UnreadSessions, b: UnreadSessions): boolean {
  if (a === b) return true
  if (a.unreadBySession.size !== b.unreadBySession.size) return false
  for (const [id, count] of a.unreadBySession) {
    if (b.unreadBySession.get(id) !== count) return false
  }
  if (a.sessions.length !== b.sessions.length) return false
  for (let i = 0; i < a.sessions.length; i += 1) {
    const left = a.sessions[i]
    const right = b.sessions[i]
    for (const field of BADGE_FIELDS) {
      if (!sameFieldValue(left[field], right[field])) return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// The one live read per window
// ---------------------------------------------------------------------------

/** `null` until the first read lands. */
let snapshot: UnreadSessions | null = null
let subscription: { unsubscribe: () => void } | null = null
const listeners = new Set<() => void>()

function publish(next: UnreadSessions): void {
  if (snapshot && sameUnreadSessions(snapshot, next)) return
  snapshot = next
  for (const listener of [...listeners]) listener()
}

function start(): void {
  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
  // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
  subscription = Dexie.liveQuery(() => loadUnreadSessions()).subscribe({
    next: publish,
    error: (error: unknown) => {
      // A badge that cannot be read says nothing rather than a stale number.
      log.warn("unread sessions read failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      publish(EMPTY_UNREAD_SESSIONS)
    },
  })
}

function stop(): void {
  subscription?.unsubscribe()
  subscription = null
}

/**
 * Subscribe to the window's unread read. The first subscriber starts the Dexie
 * observer, the last one to leave stops it. The last snapshot is kept across a
 * stop, so a remount (React StrictMode, a route change) redraws the previous
 * numbers until the fresh read lands instead of flashing zero.
 */
export function subscribeUnreadSessions(listener: () => void): () => void {
  listeners.add(listener)
  if (!subscription) start()
  let active = true
  return () => {
    if (!active) return
    active = false
    listeners.delete(listener)
    if (listeners.size === 0) stop()
  }
}

/** The latest read, or `null` before the first one lands. */
export function getUnreadSessionsSnapshot(): UnreadSessions | null {
  return snapshot
}

/** Static export never renders a badge from the database. */
export function getUnreadSessionsServerSnapshot(): UnreadSessions | null {
  return null
}

/** Test-only: drop the shared observer and the cached read. */
export function __resetUnreadSessionsForTests(): void {
  stop()
  listeners.clear()
  snapshot = null
}
