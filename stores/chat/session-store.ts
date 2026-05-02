"use client"

/**
 * Plugin-facing session store.
 *
 * cognia-next persists sessions in Dexie (`lib/db/sessions.ts`); the
 * authoritative active-session pointer lives in `useChatStore`. The
 * plugin Session API needs a Zustand surface with `sessions: Session[]`,
 * `activeSessionId`, and CRUD methods — we provide it here as an
 * adapter that hydrates lazily and delegates writes to the Dexie layer.
 *
 * This store is intentionally small: it does NOT replace `useChatStore`
 * for the rest of the app. Only plugin code reads through it.
 */

import { create } from "zustand"
import { useChatStore } from "./chat-store"
import {
  createSession as dbCreateSession,
  deleteSession as dbDeleteSession,
  listSessions as dbListSessions,
  updateSession as dbUpdateSession,
} from "@/lib/db/sessions"
import type { Session, CreateSessionInput, UpdateSessionInput } from "@/types/plugin/_compat"

interface SessionStoreState {
  sessions: Session[]
  activeSessionId: string | null
  loaded: boolean

  /** Hydrate the in-memory cache from Dexie. Idempotent. */
  load: () => Promise<void>

  createSession: (options?: CreateSessionInput) => Session
  updateSession: (id: string, updates: UpdateSessionInput) => void
  deleteSession: (id: string) => void
  setActiveSession: (id: string | null) => void
}

const PROJECT_META_KEY = "projectId"

/**
 * Synchronous-looking session creation. The plugin API expects
 * `Session` back immediately, so we mint the local row, publish it
 * into the cache, and fire a background Dexie write. If Dexie fails
 * we log; we don't rollback because the in-memory cache already has
 * what the plugin needs.
 */
function buildLocalSession(options: CreateSessionInput): Session {
  const now = Date.now()
  const id = `s_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    title: options.title ?? "New chat",
    kind: "direct",
    characterId: options.characterId,
    teamId: options.teamId,
    createdAt: now,
    updatedAt: now,
    mode: options.mode,
    projectId: options.projectId,
    branches: [],
  }
}

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  loaded: false,

  load: async () => {
    if (get().loaded) return
    try {
      const rows = await dbListSessions()
      set({ sessions: rows as Session[], loaded: true })
    } catch (err) {
      // Non-fatal: plugin code can still operate on the empty list.
      console.warn("session-store.load failed", err)
      set({ loaded: true })
    }
    // Track the chat store's active session pointer.
    set({ activeSessionId: useChatStore.getState().activeSessionId })
    useChatStore.subscribe((state) => {
      const current = get().activeSessionId
      if (state.activeSessionId !== current) {
        set({ activeSessionId: state.activeSessionId })
      }
    })
  },

  createSession: (options = {}) => {
    const session = buildLocalSession(options)
    set((state) => ({ sessions: [session, ...state.sessions] }))
    void dbCreateSession({
      title: session.title,
      characterId: session.characterId,
      teamId: session.teamId,
      kind: session.kind,
    }).catch((err) => console.warn("dbCreateSession failed", err))
    return session
  },

  updateSession: (id, updates) => {
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== id) return s
        const next: Session = {
          ...s,
          title: updates.title ?? s.title,
          mode: updates.mode ?? s.mode,
          projectId: updates.projectId ?? s.projectId,
          updatedAt: Date.now(),
        }
        return next
      }),
    }))
    const dbPatch: Parameters<typeof dbUpdateSession>[1] = {}
    if (updates.title !== undefined) dbPatch.title = updates.title
    if (updates.metadata !== undefined || updates.projectId !== undefined) {
      // cognia-next stores arbitrary session metadata under
      // `scratchpad` (string blob); we extend it with the projectId
      // tag so links survive a reload until a real Dexie column lands.
      const tag = updates.projectId ? `${PROJECT_META_KEY}=${updates.projectId}` : ""
      if (tag) dbPatch.scratchpad = tag
    }
    if (Object.keys(dbPatch).length > 0) {
      void dbUpdateSession(id, dbPatch).catch((err) => console.warn("dbUpdateSession failed", err))
    }
  },

  deleteSession: (id) => {
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
      activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
    }))
    void dbDeleteSession(id).catch((err) => console.warn("dbDeleteSession failed", err))
  },

  setActiveSession: (id) => {
    set({ activeSessionId: id })
    useChatStore.getState().setActiveSession(id)
  },
}))
