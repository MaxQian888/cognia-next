/**
 * What the extension remembers about each conversation acting in this browser
 * (ADR-0228 §6–7).
 *
 * A session is one Host conversation (`session` on every operation frame). It
 * owns the tabs it opened and the tab the user started it from, keeps them in
 * one "Cognia" tab group, remembers which of them it is working in, and holds
 * the person's take-over. Nothing here is page content.
 *
 * Kept in `chrome.storage.session`: the service worker is reclaimed at will,
 * and a conversation that loses track of its tabs mid-task would start acting
 * in whatever tab happened to be in front.
 */
import type { StorageArea } from "./storage-area"

export const AGENT_SESSIONS_KEY = "cognia.agent.sessions.v1"

export interface AgentSession {
  /** The Host conversation id. */
  id: string
  /** Tabs this session may act in, in the order it gained them. */
  tabIds: number[]
  /** Tabs it opened itself — the only ones `finalize_tabs` closes. */
  ownedTabIds: number[]
  /** The tab operations address. */
  activeTabId: number | null
  /** The tab group holding its tabs, once one exists. */
  groupId: number | null
  /** The window its tabs live in. */
  windowId: number | null
  /** Set while the person has taken control; operations are refused. */
  takeover: boolean
  /** Origins allowed for this session only ("allow once"). */
  onceOrigins: string[]
  startedAt: number
  lastActivityAt: number
}

export type AgentSessions = Record<string, AgentSession>

export function newSession(id: string, now: number): AgentSession {
  return {
    id,
    tabIds: [],
    ownedTabIds: [],
    activeTabId: null,
    groupId: null,
    windowId: null,
    takeover: false,
    onceOrigins: [],
    startedAt: now,
    lastActivityAt: now,
  }
}

/** Add a tab to a session, optionally as one it opened, and make it active. */
export function withTab(
  session: AgentSession,
  tabId: number,
  options: { owned: boolean; windowId?: number }
): AgentSession {
  return {
    ...session,
    tabIds: session.tabIds.includes(tabId) ? session.tabIds : [...session.tabIds, tabId],
    ownedTabIds:
      options.owned && !session.ownedTabIds.includes(tabId)
        ? [...session.ownedTabIds, tabId]
        : session.ownedTabIds,
    activeTabId: tabId,
    windowId: session.windowId ?? options.windowId ?? null,
  }
}

/** Forget a tab the browser closed. The active tab falls back to the last one left. */
export function withoutTab(session: AgentSession, tabId: number): AgentSession {
  const tabIds = session.tabIds.filter((id) => id !== tabId)
  return {
    ...session,
    tabIds,
    ownedTabIds: session.ownedTabIds.filter((id) => id !== tabId),
    activeTabId:
      session.activeTabId === tabId ? (tabIds[tabIds.length - 1] ?? null) : session.activeTabId,
  }
}

/** The session holding `tabId`, if any — for the acting bar and tab events. */
export function sessionForTab(sessions: AgentSessions, tabId: number): AgentSession | null {
  return Object.values(sessions).find((session) => session.tabIds.includes(tabId)) ?? null
}

/** Sessions idle longer than this are forgotten on the next sweep. */
export const SESSION_IDLE_TTL_MS = 6 * 60 * 60 * 1000

export function sweepSessions(sessions: AgentSessions, now: number): AgentSessions {
  return Object.fromEntries(
    Object.entries(sessions).filter(
      ([, session]) => now - session.lastActivityAt < SESSION_IDLE_TTL_MS
    )
  )
}

/**
 * Read-modify-write over the stored sessions, serialized.
 *
 * Operations for two conversations can land together, and two interleaved
 * read-modify-writes would each write back a map missing the other's change.
 */
export class SessionStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly area: StorageArea) {}

  async all(): Promise<AgentSessions> {
    return (await this.area.get<AgentSessions>(AGENT_SESSIONS_KEY)) ?? {}
  }

  async get(id: string): Promise<AgentSession | null> {
    return (await this.all())[id] ?? null
  }

  update<T>(
    mutate: (sessions: AgentSessions) => { sessions: AgentSessions; result: T }
  ): Promise<T> {
    const run = this.queue.then(async () => {
      const { sessions, result } = mutate(await this.all())
      await this.area.set(AGENT_SESSIONS_KEY, sessions)
      return result
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Change one session; creates it when absent. Returns the new value. */
  updateSession(
    id: string,
    now: number,
    change: (session: AgentSession) => AgentSession
  ): Promise<AgentSession> {
    return this.update((sessions) => {
      const next = { ...change(sessions[id] ?? newSession(id, now)), lastActivityAt: now }
      return { sessions: { ...sweepSessions(sessions, now), [id]: next }, result: next }
    })
  }

  remove(id: string): Promise<void> {
    return this.update((sessions) => {
      const { [id]: _removed, ...rest } = sessions
      return { sessions: rest, result: undefined }
    })
  }

  onChange(listener: (sessions: AgentSessions) => void): () => void {
    return this.area.onChange(AGENT_SESSIONS_KEY, (value) =>
      listener((value as AgentSessions | null) ?? {})
    )
  }
}
