"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { listMessages, persistMessages } from "@/lib/db/messages"
import {
  archiveSession,
  assignSessionToFolder,
  bulkArchiveSessions,
  bulkDeleteSessions,
  bulkUnarchiveSessions,
  deleteSession,
  getSession,
  listScopedSessions,
  listSessions,
  unarchiveSession,
  updateSession,
} from "@/lib/db/sessions"
import {
  createFolder as createFolderDb,
  deleteFolder as deleteFolderDb,
  listFolders,
  renameFolder as renameFolderDb,
} from "@/lib/db/session-folders"
import { resolveCharacterById } from "@/lib/db/characters"
import { buildOpeningMessage } from "@/lib/chat/opening-message"
import { startNewSession, type NewSessionInput } from "@/lib/chat/start-session"
import { getDb } from "@/lib/db/schema"
import { closeSession } from "@/lib/claude/ipc"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"
import { isTauri } from "@/lib/tauri"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"
import { filterExposedSessions } from "@/lib/chat/session-exposure"
import { isCapacitor } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { hydrateSessionHistory } from "@/lib/sync/session-history"

/**
 * How far the active session id has been resolved to a row.
 *
 * `"pending"` and `"absent"` are NOT interchangeable: the first means "not
 * looked up yet", the second means "looked up, and it is not in this
 * workspace's list". Collapsing them is what made a brand-new conversation look
 * deleted for a render.
 */
export type ActiveSessionState = "pending" | "absent" | "present"

export interface UseSessionsOptions {
  /**
   * List conversations from *every* workspace instead of only the active one.
   *
   * Only the sidebar's `groupBy: "workspace"` mode wants this — it groups by
   * workspace, which is meaningless when the list already holds exactly one.
   * The *active session* stays workspace-scoped either way (see
   * `activeSessionResolution`): a conversation from another workspace can be
   * listed and clicked, but selecting it switches the workspace first
   * (`desktop-chat-workspace.tsx:handleSwitchToSession`), so the rest of the app
   * — artifacts, terminals, the workspace panel — never disagrees with the
   * conversation on screen.
   */
  crossWorkspace?: boolean
}

export function useSessions({ crossWorkspace = false }: UseSessionsOptions = {}) {
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const setMessages = useChatStore((s) => s.setMessages)
  const setMessagesLoadError = useChatStore((s) => s.setMessagesLoadError)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const messagesReloadNonce = useChatStore((s) => s.messagesReloadNonce)
  // Active workspace — the session list is scoped to it so workspaces stay
  // isolated. Re-runs the live query on a project switch (it's in the deps).
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const projectStoreLoaded = useProjectStore((s) => s.loaded)

  // Live-bind the session list to Dexie so other tabs / quick deletes update.
  const sessions = useLiveQuery<ChatSession[]>(() => {
    if (typeof window === "undefined") return Promise.resolve([])
    if (!projectStoreLoaded || !activeProjectId) return Promise.resolve([])
    return crossWorkspace ? listSessions() : listScopedSessions(activeProjectId)
  }, [activeProjectId, projectStoreLoaded, crossWorkspace])
  const exposedSessions = useMemo(
    () => (Array.isArray(sessions) ? filterExposedSessions(sessions, "main-list") : []),
    [sessions]
  )

  // Resolve the active session's ROW, rather than leaving every consumer to
  // search `sessions` for it.
  //
  // `sessions` is a `liveQuery`, so it is eventually consistent: a conversation
  // that was just created — new chat, `/branch`, fork — is already
  // `activeSessionId` a full render before the query re-emits carrying its row.
  // A consumer that resolves the active session by searching the list reads that
  // window as "this conversation is gone"; the desktop guild reconcile did, and
  // bounced every freshly-created conversation back to the previous one (the
  // two rows visibly trading the highlight).
  //
  // The list still wins whenever it carries the row, so renames / team changes
  // stay live — the direct lookup only covers the window where it doesn't.
  const listedActiveSession = useMemo(() => {
    if (!activeSessionId) return null
    const row = exposedSessions.find((s) => s.id === activeSessionId) ?? null
    // The *active* conversation stays workspace-scoped even when the list is
    // not. "Belongs to another workspace" is what re-points the chat pane after
    // a workspace switch (which never touches `activeSessionId`), and a
    // cross-workspace list would otherwise resolve the row happily and leave
    // the previous workspace's conversation on screen.
    if (crossWorkspace && row && row.projectId && row.projectId !== activeProjectId) return null
    return row
  }, [exposedSessions, activeSessionId, crossWorkspace, activeProjectId])
  // `session: null` = looked up and genuinely not part of this workspace's list.
  const [lookedUpActive, setLookedUpActive] = useState<{
    id: string
    session: ChatSession | null
  } | null>(null)
  useEffect(() => {
    if (!activeSessionId || listedActiveSession) return
    if (!projectStoreLoaded || !activeProjectId) return
    let cancelled = false
    const id = activeSessionId
    void getSession(id)
      .then((row) => {
        if (cancelled) return
        // This list is workspace-scoped, so a row belonging to another workspace
        // is absent from it too — that is what re-points the chat pane after a
        // workspace switch, which never touches `activeSessionId` itself.
        setLookedUpActive({
          id,
          session: row && row.projectId === activeProjectId ? row : null,
        })
      })
      .catch((err) => {
        // A failed read is not evidence of absence — stay pending rather than
        // let a transient Dexie error redirect the user somewhere else.
        console.warn("resolve active session failed", err)
      })
    return () => {
      cancelled = true
    }
  }, [activeSessionId, listedActiveSession, activeProjectId, projectStoreLoaded])

  const activeSessionResolution = useMemo((): {
    state: ActiveSessionState
    session: ChatSession | null
  } => {
    if (!activeSessionId) return { state: "absent", session: null }
    if (listedActiveSession) return { state: "present", session: listedActiveSession }
    if (!lookedUpActive || lookedUpActive.id !== activeSessionId) {
      return { state: "pending", session: null }
    }
    return lookedUpActive.session
      ? { state: "present", session: lookedUpActive.session }
      : { state: "absent", session: null }
  }, [activeSessionId, listedActiveSession, lookedUpActive])

  // Live-bind the workspace's conversation folders (conversation-list overhaul).
  const folders = useLiveQuery<SessionFolder[]>(() => {
    if (typeof window === "undefined") return Promise.resolve([])
    if (!projectStoreLoaded || !activeProjectId) return Promise.resolve([])
    return listFolders(activeProjectId)
  }, [activeProjectId, projectStoreLoaded])

  // When the active session changes, hydrate its messages from Dexie. For an
  // empty session bound to a character with a persona opening message
  // (ADR-0030), seed + persist that greeting as the first assistant turn so
  // it shows immediately and survives reload. Idempotent: once seeded the
  // session is no longer empty, so re-activating it won't re-seed.
  useEffect(() => {
    if (!activeSessionId) return
    let cancelled = false
    const loadMessages = async () => {
      const local = await listMessages(activeSessionId)
      if (isTauri() || isCapacitor() || !hasWebCompanionTarget()) return local
      try {
        await hydrateSessionHistory(
          (await import("@/lib/tauri/transport-instance")).transport,
          activeSessionId
        )
        return listMessages(activeSessionId)
      } catch (error) {
        // Backward-compatible with older companion servers: keep a usable
        // recent tail when the lazy-history RPC is unavailable, but do not
        // hide a genuinely empty history failure.
        if (local.length > 0) {
          console.warn("remote session history hydration failed; using synced tail", error)
          return local
        }
        throw error
      }
    }
    loadMessages()
      .then(async (msgs) => {
        if (cancelled) return
        if (msgs.length === 0) {
          const session = await getSession(activeSessionId)
          const character = session?.characterId
            ? await resolveCharacterById(session.characterId)
            : null
          const opening = buildOpeningMessage(character)
          if (opening) {
            await persistMessages(activeSessionId, [opening])
            if (!cancelled) setMessages([opening])
            return
          }
        }
        if (!cancelled) setMessages(msgs)
      })
      .catch((err) => {
        // A transient Dexie read failure must not leave the conversation
        // silently blank (it reads as "history lost"). Surface it so the chat
        // pane can show an error + retry; don't overwrite the store with [].
        console.error("listMessages failed", err)
        if (!cancelled) {
          setMessagesLoadError(err instanceof Error ? err.message : String(err))
        }
      })
    return () => {
      cancelled = true
    }
    // `messagesReloadNonce` re-runs the load when the retry button bumps it.
  }, [activeSessionId, setMessages, setMessagesLoadError, messagesReloadNonce])

  const select = useCallback(
    (id: string | null) => {
      setActiveSession(id)
      // Plugin bus: announce the active-session switch (ids only — PII red-line).
      if (id) emitSystemBusEvent(SystemEvents.SESSION_SWITCHED, { sessionId: id })
    },
    [setActiveSession]
  )

  const create = useCallback((partial?: NewSessionInput) => startNewSession(partial), [])

  const remove = useCallback(
    async (id: string) => {
      // Tear down the live session in the sidecar if any.
      if (isTauri()) {
        try {
          await closeSession(id)
        } catch (err) {
          // Non-fatal — the sidecar may not have a session for this id.
          console.warn("closeSession failed", err)
        }
      }
      await deleteSession(id)
      emitSystemBusEvent(SystemEvents.SESSION_DELETED, { sessionId: id })
      if (useChatStore.getState().activeSessionId === id) {
        setActiveSession(null)
      }
    },
    [setActiveSession]
  )

  const rename = useCallback(async (id: string, title: string) => {
    // A manual rename opts the session out of auto-title generation.
    await updateSession(id, { title, titleAuto: false })
  }, [])

  const bulkRemove = useCallback(
    async (ids: readonly string[]) => {
      if (ids.length === 0) return
      // Tear down each live sidecar session first; tolerate per-id failures
      // (the sidecar may not be tracking some of these ids).
      if (isTauri()) {
        await Promise.all(
          ids.map(async (id) => {
            try {
              await closeSession(id)
            } catch (err) {
              console.warn("closeSession failed", err)
            }
          })
        )
      }
      await bulkDeleteSessions(ids)
      for (const id of ids) emitSystemBusEvent(SystemEvents.SESSION_DELETED, { sessionId: id })
      const current = useChatStore.getState().activeSessionId
      if (current && ids.includes(current)) {
        setActiveSession(null)
      }
    },
    [setActiveSession]
  )

  const bulkSetPinned = useCallback(async (ids: readonly string[], pinned: boolean) => {
    if (ids.length === 0) return
    await Promise.all(ids.map((id) => updateSession(id, { pinned })))
  }, [])

  const archive = useCallback(
    async (id: string) => {
      await archiveSession(id)
      // An archived session leaves the active list; deselect it if active so
      // the chat panel doesn't keep showing a now-hidden conversation.
      if (useChatStore.getState().activeSessionId === id) setActiveSession(null)
    },
    [setActiveSession]
  )

  const unarchive = useCallback(async (id: string) => {
    await unarchiveSession(id)
  }, [])

  const bulkArchive = useCallback(
    async (ids: readonly string[]) => {
      if (ids.length === 0) return
      await bulkArchiveSessions(ids)
      const current = useChatStore.getState().activeSessionId
      if (current && ids.includes(current)) setActiveSession(null)
    },
    [setActiveSession]
  )

  const bulkUnarchive = useCallback(async (ids: readonly string[]) => {
    await bulkUnarchiveSessions(ids)
  }, [])

  const createFolder = useCallback((name: string) => createFolderDb(name), [])
  const renameFolder = useCallback((id: string, name: string) => renameFolderDb(id, name), [])
  const deleteFolder = useCallback((id: string) => deleteFolderDb(id), [])
  const assignToFolder = useCallback(
    (sessionId: string, folderId: string | null) => assignSessionToFolder(sessionId, folderId),
    []
  )

  return {
    sessions: exposedSessions,
    // `useLiveQuery` returns `undefined` until the first Dexie read resolves;
    // distinguishing that from a genuinely empty list lets the session list
    // show a skeleton instead of flashing the empty state on cold start.
    isLoadingSessions: sessions === undefined,
    activeSessionId,
    /** The active session's row, or null while pending / absent. */
    activeSession: activeSessionResolution.session,
    /** See {@link ActiveSessionState} — never treat `"pending"` as `"absent"`. */
    activeSessionState: activeSessionResolution.state,
    select,
    create,
    remove,
    rename,
    bulkRemove,
    bulkSetPinned,
    archive,
    unarchive,
    bulkArchive,
    bulkUnarchive,
    folders: folders ?? [],
    createFolder,
    renameFolder,
    deleteFolder,
    assignToFolder,
    db: typeof window === "undefined" ? null : getDb(),
  }
}
