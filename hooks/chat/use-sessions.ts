"use client"

import { useCallback, useEffect, useMemo } from "react"
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

export function useSessions() {
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
    return listScopedSessions(activeProjectId)
  }, [activeProjectId, projectStoreLoaded])
  const exposedSessions = useMemo(
    () => (Array.isArray(sessions) ? filterExposedSessions(sessions, "main-list") : []),
    [sessions]
  )

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
    listMessages(activeSessionId)
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
