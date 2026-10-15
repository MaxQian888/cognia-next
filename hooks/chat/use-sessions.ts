"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { commitMessageDelta, listMessages, persistMessages } from "@/lib/db/messages"
import { closeEndedTurnToolParts } from "@/lib/chat/phantom-run"
import {
  assignSessionToFolder,
  bulkSetSessionsPinned,
  getSession,
  listWorkspaceSessions,
  listSessionListRows,
  listSessions,
  setSessionRanks,
  updateSession,
} from "@/lib/db/sessions"
import {
  createFolder as createFolderDb,
  deleteFolder as deleteFolderDb,
  listFolders,
  renameFolder as renameFolderDb,
  reorderFolders as reorderFoldersDb,
} from "@/lib/db/session-folders"
import { deleteSessionsRouted, setSessionsArchived } from "@/lib/chat/session-archive-writes"
import { resolveCharacterById } from "@/lib/db/characters"
import { buildOpeningMessage } from "@/lib/chat/opening-message"
import { startNewSession, type NewSessionInput } from "@/lib/chat/start-session"
import {
  getRuntimeTargetScopeKey,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { getDb } from "@/lib/db/schema"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"
import { isTauri } from "@/lib/tauri"
import { onTransportChange, transport } from "@/lib/tauri/transport-instance"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"
import { filterExposedSessions } from "@/lib/chat/session-exposure"
import { subscribeRemoteChanges } from "@/lib/account-sync/data/remote-changes"
import { dedupeSessionsById, shareUnchangedSessions } from "@/lib/chat/conversation-list-model"
import { isCapacitor } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import {
  hydrateSessionHistory,
  getSessionHistoryMode,
  subscribeSessionHistoryMode,
} from "@/lib/sync/session-history"
import { enqueueHostStateIntentIfAvailable } from "@/lib/db/mobile-outbound-queue"

/**
 * How far the active session id has been resolved to a row.
 *
 * `"pending"` and `"absent"` are NOT interchangeable: the first means "not
 * looked up yet", the second means "looked up, and it is not in this
 * workspace's list". Collapsing them is what made a brand-new conversation look
 * deleted for a render.
 */
export type ActiveSessionState = "pending" | "absent" | "present"

/**
 * Stable empties. A fresh `[]` per render would hand every consumer a new
 * identity on each render until the first read lands — the sidebar forwards
 * `folders` to every memoized row, so that alone busted all of them.
 */
const EMPTY_SESSIONS: readonly ChatSession[] = []
const EMPTY_FOLDERS: SessionFolder[] = []
const getTransportSnapshot = () => transport

export interface UseSessionsOptions {
  /** Read encrypted list projections; hydrate only the visible chat panes in full. */
  listOnly?: boolean
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
  /**
   * Run the session live query at all. Defaults to true.
   *
   * `false` keeps the imperative half of this hook (`select`, `create`, the
   * folder writes) while leaving `sessions` empty — for a consumer that is
   * mounted permanently but only *looks* at the list some of the time. The
   * command palette is the case that forced this: it is mounted unconditionally
   * by `desktop-app-shell.tsx`, and its `crossWorkspace` live query re-read
   * every full session row — `branchSeed.content` included, up to 24k chars
   * each — on every `sessions` write, which during a streaming turn is once per
   * persisted chunk, with the dialog closed.
   */
  enabled?: boolean
}

export function useSessions({
  crossWorkspace = false,
  enabled = true,
  listOnly = false,
}: UseSessionsOptions = {}) {
  const activeTransport = useSyncExternalStore(
    onTransportChange,
    getTransportSnapshot,
    getTransportSnapshot
  )
  const runtimeScope = useSyncExternalStore(
    subscribeRuntimeTargetContext,
    getRuntimeTargetScopeKey,
    getRuntimeTargetScopeKey
  )
  const databaseName = typeof window === "undefined" ? "" : getDb().name
  const scopeKey = JSON.stringify([runtimeScope, databaseName])
  const isCurrentScope = useCallback(
    () => getRuntimeTargetScopeKey() === runtimeScope && getDb().name === databaseName,
    [runtimeScope, databaseName]
  )
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const setMessages = useChatStore((s) => s.setMessages)
  const setSessionMessagesLoading = useChatStore((s) => s.setSessionMessagesLoading)
  const setMessagesLoadError = useChatStore((s) => s.setMessagesLoadError)
  const hydrateSessionActiveBranches = useChatStore((s) => s.hydrateSessionActiveBranches)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const splitSessionId = useChatStore((s) => s.splitSessionId)
  const openSessionIds = useChatStore((s) => s.openSessionIds)
  const messagesReloadNonce = useChatStore((s) => s.messagesReloadNonce)
  // Active workspace — the session list is scoped to it so workspaces stay
  // isolated. Re-runs the live query on a project switch (it's in the deps).
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const projectStoreLoaded = useProjectStore((s) => s.loaded)
  const previousScopeRef = useRef(scopeKey)
  useEffect(() => {
    if (previousScopeRef.current === scopeKey) return
    previousScopeRef.current = scopeKey
    // Pane IDs can be shared across Hosts; their optimistic/runtime state cannot.
    const chat = useChatStore.getState()
    for (const id of new Set([...chat.openSessionIds, chat.activeSessionId, chat.splitSessionId])) {
      if (!id) continue
      chat.setSessionMessages(id, [])
      chat.setSessionStatus(id, "idle")
      chat.setSessionMessagesLoading(id, true)
      chat.hydrateSessionActiveBranches(id, {})
    }
  }, [scopeKey])

  // The previous emission, so the next one can keep the rows that did not
  // change (`shareUnchangedSessions`). Only the querier below touches it, and
  // Dexie runs the querier outside render.
  const sharedSessionsRef = useRef<{ key: string; rows: readonly ChatSession[] } | undefined>(
    undefined
  )
  // Live-bind the session list to Dexie so other tabs / quick deletes update.
  //
  // Structurally shared: a streaming reply rewrites its session row several
  // times a second (`transcriptRevision`), and a fresh clone of every row on
  // each of those writes re-rendered the whole sidebar — every row, every
  // derived map — for a change nothing on screen shows. Unchanged rows keep
  // their identity; a write that changed nothing listable hands back the
  // previous array, which `useLiveQuery` skips without rendering at all.
  const listRead = useLiveQuery(
    async function readSessionList() {
      if (typeof window === "undefined") return { key: scopeKey, rows: EMPTY_SESSIONS }
      if (!enabled) return { key: scopeKey, rows: EMPTY_SESSIONS }
      if (!projectStoreLoaded || !activeProjectId) return { key: scopeKey, rows: EMPTY_SESSIONS }
      // Scoped reads keep the conversations of NO workspace (a paired client's
      // host-synced history, pre-workspace chats) — see `listWorkspaceSessions`.
      const rows = await (listOnly
        ? listSessionListRows(crossWorkspace ? undefined : activeProjectId)
        : crossWorkspace
          ? listSessions()
          : listWorkspaceSessions(activeProjectId))
      if (!isCurrentScope()) return undefined
      const previous = sharedSessionsRef.current
      const shared = shareUnchangedSessions(
        previous?.key === scopeKey ? previous.rows : undefined,
        rows
      )
      const snapshot =
        previous?.key === scopeKey && previous.rows === shared
          ? previous
          : { key: scopeKey, rows: shared }
      sharedSessionsRef.current = snapshot
      return snapshot
    },
    [activeProjectId, projectStoreLoaded, crossWorkspace, enabled, listOnly, scopeKey]
  )
  const sessions = listRead?.key === scopeKey ? listRead.rows : undefined
  const exposedSessions = useMemo(() => {
    if (!Array.isArray(sessions)) return []
    const exposed = filterExposedSessions(sessions, "main-list")
    // One row per conversation, whatever the live query hands us. A duplicate
    // id here becomes a duplicate React key in every consumer (sidebar rows,
    // the welcome page's "Continue" grid) and a chat listed twice; the model
    // guards its own input too, but the welcome grid reads this list directly.
    // Kept loud: a duplicate is a symptom of an upstream emit that should not
    // happen, so leave a trail that names the rows instead of hiding it.
    const unique = dedupeSessionsById(exposed)
    if (unique !== exposed) {
      const seen = new Set<string>()
      const repeated = new Set<string>()
      for (const row of exposed) (seen.has(row.id) ? repeated : seen).add(row.id)
      console.warn("useSessions: live query emitted duplicate session rows", {
        ids: Array.from(repeated),
        crossWorkspace,
      })
    }
    return unique as ChatSession[]
  }, [sessions, crossWorkspace])

  const visibleSplitId =
    splitSessionId && openSessionIds?.includes(splitSessionId) ? splitSessionId : null
  const paneQueryKey = JSON.stringify([
    scopeKey,
    activeProjectId,
    activeSessionId,
    visibleSplitId,
    enabled,
    projectStoreLoaded,
  ])
  const sharedPanesRef = useRef<{ key: string; rows: readonly ChatSession[] } | undefined>(
    undefined
  )
  const paneRead = useLiveQuery(async () => {
    if (!listOnly || !enabled || !projectStoreLoaded || !activeProjectId) return undefined
    const ids = [
      ...new Set([activeSessionId, visibleSplitId].filter((id): id is string => Boolean(id))),
    ]
    try {
      const rows = (await Promise.all(ids.map((id) => getSession(id)))).filter(
        (row): row is ChatSession =>
          row !== undefined && (!row.projectId || row.projectId === activeProjectId)
      )
      if (!isCurrentScope()) return undefined
      const exposed = filterExposedSessions(rows, "main-list")
      const previous = sharedPanesRef.current
      const shared = shareUnchangedSessions(
        previous?.key === paneQueryKey ? previous.rows : undefined,
        exposed
      )
      const snapshot =
        previous?.key === paneQueryKey && previous.rows === shared
          ? previous
          : { key: paneQueryKey, rows: shared }
      sharedPanesRef.current = snapshot
      return snapshot
    } catch (error) {
      // A failed lookup is not evidence of deletion. Retain only a snapshot
      // for this exact workspace and pane selection; otherwise stay pending.
      console.warn("resolve active session failed", error)
      return sharedPanesRef.current?.key === paneQueryKey ? sharedPanesRef.current : undefined
    }
  }, [listOnly, paneQueryKey])
  const paneRows = paneRead?.key === paneQueryKey ? paneRead.rows : undefined

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
  const activeLookupKey = JSON.stringify([scopeKey, activeProjectId])
  const [lookedUpActive, setLookedUpActive] = useState<{
    id: string
    key: string
    session: ChatSession | null
  } | null>(null)
  useEffect(() => {
    if (listOnly || !activeSessionId || listedActiveSession) return
    if (!projectStoreLoaded || !activeProjectId) return
    let cancelled = false
    const id = activeSessionId
    void getSession(id)
      .then((row) => {
        if (cancelled || !isCurrentScope()) return
        // This list is workspace-scoped, so a row belonging to another workspace
        // is absent from it too — that is what re-points the chat pane after a
        // workspace switch, which never touches `activeSessionId` itself.
        setLookedUpActive({
          id,
          key: activeLookupKey,
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
  }, [
    activeSessionId,
    listedActiveSession,
    activeProjectId,
    projectStoreLoaded,
    listOnly,
    activeLookupKey,
    isCurrentScope,
  ])

  const activeSessionResolution = useMemo((): {
    state: ActiveSessionState
    session: ChatSession | null
  } => {
    if (!activeSessionId) return { state: "absent", session: null }
    if (listOnly) {
      if (!paneRows) return { state: "pending", session: null }
      const row = paneRows.find((session) => session.id === activeSessionId) ?? null
      return { state: row ? "present" : "absent", session: row }
    }
    if (listedActiveSession) return { state: "present", session: listedActiveSession }
    if (
      !lookedUpActive ||
      lookedUpActive.id !== activeSessionId ||
      lookedUpActive.key !== activeLookupKey
    ) {
      return { state: "pending", session: null }
    }
    return lookedUpActive.session
      ? { state: "present", session: lookedUpActive.session }
      : { state: "absent", session: null }
  }, [activeSessionId, listedActiveSession, lookedUpActive, listOnly, paneRows, activeLookupKey])

  // Live-bind the workspace's conversation folders (conversation-list overhaul).
  const folderRead = useLiveQuery(
    async function readSessionFolders() {
      const rows =
        typeof window === "undefined" || !projectStoreLoaded || !activeProjectId
          ? EMPTY_FOLDERS
          : await listFolders(activeProjectId)
      return isCurrentScope() ? { key: scopeKey, rows } : undefined
    },
    [activeProjectId, projectStoreLoaded, scopeKey]
  )
  const folders = folderRead?.key === scopeKey ? folderRead.rows : undefined

  const [historyInvalidationNonce, setHistoryInvalidationNonce] = useState(0)
  useEffect(() => {
    if (!activeSessionId) return
    return subscribeSessionHistoryMode(activeSessionId, () => {
      if (getSessionHistoryMode(activeSessionId) === null)
        setHistoryInvalidationNonce((value) => value + 1)
    })
  }, [activeSessionId, scopeKey])

  // Account sync writes another device's messages straight into Dexie; reload
  // the visible transcript when they land, unless this tab is mid-turn there
  // (the hydration below also yields to any newer in-memory messages).
  const visibleStatusKey = useChatStore((state) =>
    JSON.stringify([
      state.sessions[activeSessionId ?? ""]?.status,
      state.sessions[visibleSplitId ?? ""]?.status,
    ])
  )
  const pendingRemote = useRef(new Set<string>())
  const [remoteMessagesNonce, setRemoteMessagesNonce] = useState<Record<string, number>>({})
  const drainRemote = useCallback(() => {
    if (!isCurrentScope()) return
    const ready = [...pendingRemote.current].filter((id) => {
      const status = useChatStore.getState().sessions[id]?.status
      return status !== "streaming" && status !== "awaiting_approval"
    })
    if (ready.length === 0) return
    ready.forEach((id) => pendingRemote.current.delete(id))
    setRemoteMessagesNonce((previous) => {
      const next = { ...previous }
      ready.forEach((id) => {
        next[id] = (next[id] ?? 0) + 1
      })
      return next
    })
  }, [isCurrentScope])
  useEffect(() => {
    pendingRemote.current.clear()
  }, [scopeKey])
  useEffect(() => {
    return subscribeRemoteChanges((tables) => {
      if (!tables.has("messages") || !isCurrentScope()) return
      for (const id of [activeSessionId, visibleSplitId]) if (id) pendingRemote.current.add(id)
      drainRemote()
    })
  }, [activeSessionId, visibleSplitId, isCurrentScope, drainRemote])
  useEffect(() => {
    drainRemote()
  }, [visibleStatusKey, drainRemote])

  // Shared projections commit their messages and cursor together. Subscribe to
  // that cursor so incoming events refresh the currently visible transcript.
  const sharedProjectionCursor = exposedSessions.find((row) => row.id === activeSessionId)
    ?.collaboration?.syncCursor

  // When the active session changes, hydrate its messages from Dexie. For an
  // empty session bound to a character with a persona opening message
  // (ADR-0030), seed + persist that greeting as the first assistant turn so
  // it shows immediately and survives reload. Idempotent: once seeded the
  // session is no longer empty, so re-activating it won't re-seed.
  useEffect(() => {
    const ids = [
      ...new Set([activeSessionId, visibleSplitId].filter((id): id is string => Boolean(id))),
    ]
    let cancelled = false
    const stale = () => cancelled || !isCurrentScope() || transport !== activeTransport
    for (const sessionId of ids) {
      if (pendingRemote.current.has(sessionId)) continue
      const publishMessages = (messages: Awaited<ReturnType<typeof listMessages>>) => {
        if (stale()) return
        if (useChatStore.getState().activeSessionId === sessionId) setMessages(messages)
        else useChatStore.getState().setSessionMessages(sessionId, messages)
      }
      const hydrationBase = useChatStore.getState().sessions[sessionId]?.messages
      const liveMessagesChanged = () =>
        useChatStore.getState().sessions[sessionId]?.messages !== hydrationBase
      const finishSupersededHydration = () => {
        setSessionMessagesLoading(sessionId, false)
      }
      const loadMessages = async () => {
        const local = await listMessages(sessionId)
        if (stale()) return local
        if (isTauri() || isCapacitor() || !hasWebCompanionTarget()) return local
        try {
          if (stale()) return local
          const hydration = await hydrateSessionHistory(activeTransport, sessionId)
          // Transcript-capable hosts are rendered from bounded timeline pages;
          // keep only the already-synced recent tail in Zustand for the active
          // turn. Legacy hosts still require the fully hydrated Dexie snapshot.
          if (stale()) return local
          return hydration.mode === "timeline" ? local : listMessages(sessionId)
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
          if (stale()) return
          const session = await getSession(sessionId)
          if (stale()) return
          hydrateSessionActiveBranches(sessionId, session?.activeBranchByGroup ?? {})
          // The first send can win while this activation read is still in flight.
          // Publishing the older Dexie snapshot after that point replaces the
          // optimistic/streaming array, then the next SDK event replaces it back;
          // the two orders visibly trade places until persistence catches up.
          // Message arrays are immutable in the chat store, so reference identity
          // is a precise generation check without introducing another counter.
          if (liveMessagesChanged()) {
            finishSupersededHydration()
            return
          }
          if (msgs.length === 0) {
            const character = session?.characterId
              ? await resolveCharacterById(session.characterId)
              : null
            if (stale()) return
            if (liveMessagesChanged()) {
              finishSupersededHydration()
              return
            }
            const opening = buildOpeningMessage(character)
            if (opening) {
              await persistMessages(sessionId, [opening])
              if (stale()) return
              if (liveMessagesChanged()) {
                finishSupersededHydration()
                return
              }
              publishMessages([opening])
              return
            }
          }
          if (stale()) return
          // A turn that ended without delivering its tool results (a timed-out
          // prompt, a runtime that died, a reload mid-turn) left those calls
          // open, and every reload would show them "running" again. Close the
          // ones the transcript proves are over, and write the fix back so the
          // repair happens once.
          const busy = (() => {
            const status = useChatStore.getState().sessions[sessionId]?.status
            return status === "streaming" || status === "awaiting_approval"
          })()
          const repaired = closeEndedTurnToolParts(msgs, { trailingMayBeLive: busy })
          if (repaired.changed.length > 0) {
            void commitMessageDelta(sessionId, { upserts: repaired.changed }).catch(
              (error: unknown) => console.warn("closing interrupted tool calls failed", error)
            )
          }
          publishMessages(repaired.messages)
        })
        .catch((err) => {
          // A transient Dexie read failure must not leave the conversation
          // silently blank (it reads as "history lost"). Surface it so the chat
          // pane can show an error + retry; don't overwrite the store with [].
          console.error("listMessages failed", err)
          if (!stale()) {
            const message = err instanceof Error ? err.message : String(err)
            if (useChatStore.getState().activeSessionId === sessionId) setMessagesLoadError(message)
            else useChatStore.getState().setSessionMessagesLoadError(sessionId, message)
          }
        })
    }
    return () => {
      cancelled = true
    }
    // Transport replacement also retries a scope activated before its pairing was ready.
    // `messagesReloadNonce` re-runs the load when the retry button bumps it.
  }, [
    activeTransport,
    activeSessionId,
    hydrateSessionActiveBranches,
    setMessages,
    setSessionMessagesLoading,
    setMessagesLoadError,
    messagesReloadNonce,
    historyInvalidationNonce,
    sharedProjectionCursor,
    remoteMessagesNonce,
    visibleSplitId,
    isCurrentScope,
  ])

  const select = useCallback(
    (id: string | null) => {
      if (!isCurrentScope()) return
      setActiveSession(id)
      // Plugin bus: announce the active-session switch (ids only — PII red-line).
      if (id) emitSystemBusEvent(SystemEvents.SESSION_SWITCHED, { sessionId: id })
    },
    [setActiveSession, isCurrentScope]
  )

  const create = useCallback(
    (partial?: NewSessionInput) => {
      if (!isCurrentScope()) return Promise.reject(new Error("Session database scope changed"))
      return startNewSession(partial)
    },
    [isCurrentScope]
  )

  const remove = useCallback(
    async (id: string) => {
      // A paired client hands the delete to its Host, which runs the cascade
      // and the sidecar teardown there and confirms a tombstone every replica
      // applies. Only when no Host takes the write is it carried out here.
      // The local teardown deselects what it deleted; a Host-owned delete is
      // left the same way, rather than keep a composer open against a row
      // about to disappear.
      if (!isCurrentScope()) return
      await deleteSessionsRouted([id])
      if (!isCurrentScope()) return
      if (useChatStore.getState().activeSessionId === id) setActiveSession(null)
    },
    [setActiveSession, isCurrentScope]
  )

  const rename = useCallback(
    async (id: string, title: string) => {
      if (!isCurrentScope()) return
      // A manual rename opts the session out of auto-title generation.
      if (
        await enqueueHostStateIntentIfAvailable({
          sessionId: id,
          action: { kind: "session.rename", title },
        })
      ) {
        return
      }
      if (!isCurrentScope()) return
      await updateSession(id, { title, titleAuto: false })
    },
    [isCurrentScope]
  )

  const bulkRemove = useCallback(
    async (ids: readonly string[]) => {
      if (ids.length === 0 || !isCurrentScope()) return
      const uniqueIds = [...new Set(ids)]
      // The local cascade deselects what it deleted; the Host-owned ones are
      // left the same way `remove` leaves them.
      if (!isCurrentScope()) return
      await deleteSessionsRouted(uniqueIds)
      if (!isCurrentScope()) return
      const current = useChatStore.getState().activeSessionId
      if (current && uniqueIds.includes(current)) setActiveSession(null)
    },
    [setActiveSession, isCurrentScope]
  )

  const bulkSetPinned = useCallback(
    async (ids: readonly string[], pinned: boolean) => {
      if (ids.length === 0 || !isCurrentScope()) return
      const uniqueIds = [...new Set(ids)]
      const queued = await Promise.all(
        uniqueIds.map((sessionId) =>
          enqueueHostStateIntentIfAvailable({ sessionId, action: { kind: "session.pin", pinned } })
        )
      )
      if (!isCurrentScope()) return
      const legacyIds = uniqueIds.filter((_, index) => !queued[index])
      if (legacyIds.length > 0) await bulkSetSessionsPinned(legacyIds, pinned)
    },
    [isCurrentScope]
  )

  const archive = useCallback(
    async (id: string) => {
      if (!isCurrentScope()) return
      await setSessionsArchived([id], true)
      if (!isCurrentScope()) return
      // An archived session leaves the active list; deselect it if active so
      // the chat panel doesn't keep showing a now-hidden conversation.
      if (useChatStore.getState().activeSessionId === id) setActiveSession(null)
    },
    [setActiveSession, isCurrentScope]
  )

  const unarchive = useCallback(
    async (id: string) => {
      if (isCurrentScope()) await setSessionsArchived([id], false)
    },
    [isCurrentScope]
  )

  const bulkArchive = useCallback(
    async (ids: readonly string[]) => {
      if (ids.length === 0 || !isCurrentScope()) return
      if (!isCurrentScope()) return
      await setSessionsArchived(ids, true)
      if (!isCurrentScope()) return
      const current = useChatStore.getState().activeSessionId
      if (current && ids.includes(current)) setActiveSession(null)
    },
    [setActiveSession, isCurrentScope]
  )

  const bulkUnarchive = useCallback(
    async (ids: readonly string[]) => {
      if (isCurrentScope()) await setSessionsArchived(ids, false)
    },
    [isCurrentScope]
  )

  // Folder writes route themselves (`lib/db/session-folders.ts`): on a paired
  // client each becomes a `folder.*` HostState intent — a create also shows its
  // row at once, under the id the Host adopts — and the Host's folders come
  // back through `sessionFolders` table sync. A folder delete unfiles its
  // members in the Host's own transaction, so nothing here routes them.
  // Standalone, all four write locally.
  const createFolder = useCallback(
    (name: string) => {
      if (!isCurrentScope()) return Promise.reject(new Error("Session database scope changed"))
      return createFolderDb(name)
    },
    [isCurrentScope]
  )
  const renameFolder = useCallback(
    async (id: string, name: string) => {
      if (isCurrentScope()) await renameFolderDb(id, name)
    },
    [isCurrentScope]
  )
  const deleteFolder = useCallback(
    async (id: string) => {
      if (isCurrentScope()) await deleteFolderDb(id)
    },
    [isCurrentScope]
  )
  const reorderFolders = useCallback(
    async (ids: string[]) => {
      if (isCurrentScope()) await reorderFoldersDb(ids)
    },
    [isCurrentScope]
  )
  const assignToFolder = useCallback(
    async (sessionId: string, folderId: string | null) => {
      if (!isCurrentScope()) return
      const queued = await enqueueHostStateIntentIfAvailable({
        sessionId,
        action: { kind: "session.folder", folderId },
      })
      if (!isCurrentScope()) return
      if (!queued) await assignSessionToFolder(sessionId, folderId)
    },
    [isCurrentScope]
  )
  // File a whole selection at once. The rows a Host takes are forwarded one
  // intent each; the rest are filed locally in one transaction, so the list's
  // live query re-emits once for the batch rather than once per row, and a row
  // that refuses the write (a handoff-locked conversation) rolls the whole
  // local move back instead of leaving the selection half-filed. The
  // single-row writer joins the ambient transaction — it reads and writes
  // through the same db.
  const bulkAssignToFolder = useCallback(
    async (ids: readonly string[], folderId: string | null) => {
      if (ids.length === 0 || !isCurrentScope()) return
      const uniqueIds = [...new Set(ids)]
      const queued = await Promise.all(
        uniqueIds.map((sessionId) =>
          enqueueHostStateIntentIfAvailable({
            sessionId,
            action: { kind: "session.folder", folderId },
          })
        )
      )
      if (!isCurrentScope()) return
      const legacyIds = uniqueIds.filter((_, index) => !queued[index])
      if (legacyIds.length === 0) return
      const db = getDb()
      await db.transaction("rw", db.sessions, () =>
        Promise.all(legacyIds.map((id) => assignSessionToFolder(id, folderId)))
      )
    },
    [isCurrentScope]
  )
  /**
   * Persist a drag-reorder of one conversation-list section. `ids` are the
   * section's rows in their new order; `sectionKey` is the section's
   * `conversationSectionKey` (see `setSessionOrder`). Each row a Host takes is
   * forwarded with its rank in the FULL arrangement; the rest keep that same
   * rank locally, so a mixed batch cannot collide.
   */
  const reorderSessions = useCallback(
    async (ids: readonly string[], sectionKey: string) => {
      if (ids.length === 0 || !isCurrentScope()) return
      const ranks = ids.map((id, manualOrder) => ({ id, manualOrder }))
      const queued = await Promise.all(
        ranks.map(({ id, manualOrder }) =>
          enqueueHostStateIntentIfAvailable({
            sessionId: id,
            action: { kind: "session.order", manualOrder, sectionKey },
          })
        )
      )
      if (!isCurrentScope()) return
      const legacyRanks = ranks.filter((_, index) => !queued[index])
      if (legacyRanks.length > 0) await setSessionRanks(legacyRanks, sectionKey)
    },
    [isCurrentScope]
  )

  return {
    /**
     * The listable conversations. Structurally shared across live-query
     * emissions (see `shareUnchangedSessions`): a row that did not change keeps
     * its identity, and a kept row carries the list-inert fields
     * (`transcriptRevision`) of the read it came from — read those from Dexie.
     */
    sessions: exposedSessions,
    /** Full rows for chat panes; projections must never supply execution settings. */
    paneSessions: listOnly ? (paneRows ?? EMPTY_SESSIONS) : exposedSessions,
    // `useLiveQuery` returns `undefined` until the first Dexie read resolves;
    // distinguishing that from a genuinely empty list lets the session list
    // show a skeleton instead of flashing the empty state on cold start. The
    // query also answers `[]` while the project store is still hydrating (it
    // has no workspace to scope to yet), so that counts as loading too — that
    // `[]` is "not asked yet", not "you have no conversations".
    isLoadingSessions: sessions === undefined || (enabled && !projectStoreLoaded),
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
    folders: folders ?? EMPTY_FOLDERS,
    createFolder,
    renameFolder,
    deleteFolder,
    reorderFolders,
    assignToFolder,
    bulkAssignToFolder,
    reorderSessions,
    db: typeof window === "undefined" ? null : getDb(),
  }
}
