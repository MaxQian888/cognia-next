/**
 * IM notify-on-settle store — the state + delivery seam behind the welcome
 * composer's context bar bell.
 *
 * Two halves:
 *
 *   Prefs (persisted): whether new conversations arm IM notification, which
 *   bound conversation the ping lands in (`null` = auto → first reachable),
 *   and which run events fire it (done / error / attention).
 *
 *   Armed registry (persisted): `sessionId → snapshot of the prefs at create
 *   time`. Snapshotted, not live-read, so editing the bar later does not
 *   retroactively re-arm sessions the user already sent.
 *
 * `installImNotifyWatcher` subscribes to the chat store's per-session status
 * machine (`streaming → idle` = done, `→ error` = error, `→ awaiting_approval`
 * = attention) and pushes through `notifyConversationOverIM` — the same
 * control-plane pipe every other subsystem uses, so PII gating, the
 * proactive-push opt-in, dedup, and audit all apply downstream.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"

import { persistLocalStorage } from "@/stores/persist-storage"
import { useChatStore, type ChatStatus } from "@/stores/chat/chat-store"
import type { PlatformKind } from "@/types/connectors/platform-kind"

export type ImNotifyEvent = "done" | "error" | "attention"

export interface ImNotifyEvents {
  done: boolean
  error: boolean
  attention: boolean
}

const DEFAULT_EVENTS: ImNotifyEvents = { done: true, error: true, attention: false }

/** The prefs snapshot armed onto a session when it is created. */
export interface ArmedImNotify {
  conversationKey: string | null
  events: ImNotifyEvents
  armedAt: number
}

interface ImNotifyState {
  enabled: boolean
  /** `null` = auto — resolved to the first reachable bound conversation. */
  conversationKey: string | null
  events: ImNotifyEvents
  /** Sessions this flag armed at creation — persisted so a reload mid-run
      still delivers. */
  armed: Record<string, ArmedImNotify>

  setEnabled: (next: boolean) => void
  setConversationKey: (key: string | null) => void
  toggleEvent: (event: ImNotifyEvent) => void
  /** Snapshot the current prefs onto a freshly created session. */
  armSession: (sessionId: string) => void
  disarmSession: (sessionId: string) => void
}

export const useImNotifyStore = create<ImNotifyState>()(
  persist(
    (set, get) => ({
      enabled: false,
      conversationKey: null,
      events: { ...DEFAULT_EVENTS },
      armed: {},

      setEnabled: (enabled) => set({ enabled }),
      setConversationKey: (conversationKey) => set({ conversationKey }),
      toggleEvent: (event) => set((s) => ({ events: { ...s.events, [event]: !s.events[event] } })),
      armSession: (sessionId) => {
        if (!get().enabled) return
        set((s) => {
          const armed = { ...s.armed }
          // Sessions are never un-armed on settle (a conversation can run many
          // turns, each of which should ping), so cap the registry — oldest
          // entries are almost certainly dead sessions.
          const keys = Object.keys(armed)
          if (keys.length >= 200) {
            keys
              .sort((a, b) => armed[a].armedAt - armed[b].armedAt)
              .slice(0, keys.length - 199)
              .forEach((k) => delete armed[k])
          }
          armed[sessionId] = {
            conversationKey: s.conversationKey,
            events: { ...s.events },
            armedAt: Date.now(),
          }
          return { armed }
        })
      },
      disarmSession: (sessionId) =>
        set((s) => {
          if (!(sessionId in s.armed)) return s
          const armed = { ...s.armed }
          delete armed[sessionId]
          return { armed }
        }),
    }),
    { name: "im-notify", storage: persistLocalStorage() }
  )
)

// ---------------------------------------------------------------------------
// Bound-conversation enumeration — the channel picker's rows. A conversation
// is listed when the connector runtime has seen it (a
// `connectorConversationStates` row) AND still holds a live delivery target.
// ---------------------------------------------------------------------------

export interface NotifyConversation {
  conversationKey: string
  adapterId: string
  platform: PlatformKind
  /** private | group | channel | thread — the picker's subtitle. */
  scopeKind: string
  /** Adapter display name — "Lark Bot · production", not a raw key. */
  adapterName: string
}

export async function listNotifyConversations(): Promise<NotifyConversation[]> {
  const { getDb } = await import("@/lib/db/schema")
  const { listAdapterInstances } = await import("@/lib/db/adapter-instances")
  const [rows, adapters] = await Promise.all([
    getDb().connectorConversationStates.toArray(),
    listAdapterInstances(),
  ])
  const adapterById = new Map(adapters.map((a) => [a.id, a]))
  const out: NotifyConversation[] = []
  for (const row of rows) {
    if (!row.deliveryTarget) continue
    const adapter = adapterById.get(row.adapterId)
    if (!adapter?.enabled || adapter.muted) continue
    out.push({
      conversationKey: row.conversationKey,
      adapterId: row.adapterId,
      platform: row.deliveryTarget.address.platform,
      scopeKind: row.deliveryTarget.address.scopeKind,
      adapterName: adapter.displayName,
    })
  }
  // Private conversations first — "ping me" almost always means a DM.
  return out.sort((a, b) => Number(b.scopeKind === "private") - Number(a.scopeKind === "private"))
}

/** `conversationKey` for the picker's "auto" choice, or undefined when the
    user has no reachable bound conversation at all. */
export async function resolveAutoConversation(): Promise<string | undefined> {
  const list = await listNotifyConversations()
  return list[0]?.conversationKey
}

// ---------------------------------------------------------------------------
// Watcher — one subscription over the chat store's per-session status machine.
// ---------------------------------------------------------------------------

export interface ImNotifyStrings {
  done: (title: string) => string
  error: (title: string) => string
  attention: (title: string) => string
}

export interface ImNotifyWatcherDeps {
  /** Defaults to the real notification pipe; tests inject a spy. */
  push: (input: {
    conversationKey: string
    title: string
    level: "success" | "error" | "warning"
    source: "session"
    dedupeKey: string
    directed?: boolean
  }) => Promise<unknown>
  resolveAuto: () => Promise<string | undefined>
  sessionTitle: (sessionId: string) => Promise<string | undefined>
}

const TERMINAL: Readonly<Record<ChatStatus, ImNotifyEvent | null>> = {
  idle: "done",
  error: "error",
  awaiting_approval: "attention",
  streaming: null,
}

async function defaultSessionTitle(sessionId: string): Promise<string | undefined> {
  const { getDb } = await import("@/lib/db/schema")
  return (await getDb().sessions.get(sessionId))?.title
}

/**
 * Subscribe once; returns the unsubscribe. A settle transition on an armed
 * session fires the matching event when that event was on at arm time. `idle`
 * only counts as "done" when the slice was actually busy first — a session
 * sitting untouched at idle must not ping on subscription replay.
 */
export function installImNotifyWatcher(
  strings: ImNotifyStrings,
  deps?: Partial<ImNotifyWatcherDeps>
): () => void {
  const push =
    deps?.push ??
    (async (input) => {
      const { notifyConversationOverIM } = await import("@/lib/notifications/conversation-notify")
      return notifyConversationOverIM(input)
    })
  const resolveAuto = deps?.resolveAuto ?? resolveAutoConversation
  const sessionTitle = deps?.sessionTitle ?? defaultSessionTitle

  return useChatStore.subscribe((state, prev) => {
    for (const [sessionId, armed] of Object.entries(useImNotifyStore.getState().armed)) {
      const slice = state.sessions[sessionId]
      const prevSlice = prev.sessions[sessionId]
      const next = slice?.status ?? (sessionId === state.activeSessionId ? state.status : null)
      const before = prevSlice?.status ?? (sessionId === prev.activeSessionId ? prev.status : null)
      if (!next || !before || next === before) continue

      const event = TERMINAL[next]
      // "done" requires a busy → idle edge; an untouched idle slice settling
      // (e.g. on hydration) is not a completion.
      const busyBefore = before === "streaming" || before === "awaiting_approval"
      if (!event || !armed.events[event]) continue
      if (event === "done" && !busyBefore) continue

      void (async () => {
        const conversationKey = armed.conversationKey ?? (await resolveAuto())
        if (!conversationKey) return
        const title = (await sessionTitle(sessionId)) ?? sessionId
        const text =
          event === "done"
            ? strings.done(title)
            : event === "error"
              ? strings.error(title)
              : strings.attention(title)
        await push({
          conversationKey,
          title: text,
          source: "session",
          level: event === "done" ? "success" : event === "error" ? "error" : "warning",
          directed: event === "attention",
          dedupeKey: `im-notify:${sessionId}:${event}:${slice?.runId ?? 0}`,
        })
      })().catch(() => undefined)
    }
  })
}
