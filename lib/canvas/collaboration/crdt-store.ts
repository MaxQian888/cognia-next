/**
 * The shared document behind Canvas collaboration.
 *
 * The public shape (`createSession` / `joinSession` / `applyLocalUpdate` /
 * `applyRemoteUpdate` / `subscribe` / …) is unchanged, because
 * `use-collaborative-session.ts`, `CollaborationPanel` and the websocket
 * provider are written against it. What changed is what is underneath.
 *
 * It used to be positional, with no transform of any kind. An operation was an
 * absolute character index plus text, and `applyOperation` spliced it into the
 * receiver's already-mutated string. Two people inserting at index 10 both
 * applied at raw index 10, neither index rebased against the other, and the
 * documents silently diverged while `version` incremented on both sides. The
 * only conflict machinery was a causal gate that DROPPED anything it could not
 * order, with no buffer and no retry, so a late operation was lost forever.
 *
 * Yjs is that machinery. Positions are resolved against the document's own
 * structure rather than an index into a string, updates commute, and a late
 * update merges when it arrives instead of being discarded. The update payload
 * on the wire is Yjs's binary encoding, base64 for a JSON transport.
 *
 * Two things are deliberately gone with the old implementation:
 *
 * - `deserializeState(json)` parsed attacker-supplied JSON and pushed the
 *   result straight into the session and document maps with no validation at
 *   all. It was reachable from a share link and from any inbound frame typed
 *   `"sync"`. State is applied through `applyRemoteUpdate` now, which hands
 *   bytes to Yjs and cannot install a session.
 * - The unbounded `operations` log, which grew per keystroke and was shipped
 *   whole inside every share link.
 */

import * as Y from "yjs"
import { fromBase64, toBase64 } from "lib0/buffer"
import type {
  CollaborativeSession,
  Participant,
  CursorPosition,
  ContentUpdate,
  CollaborationUpdate,
} from "@/types/canvas/collaboration"
import * as canvasSessionsDb from "@/lib/db/canvas-sessions"
import { loggers } from "@cognia/logging"

/** The one key every Canvas document's text lives under inside its `Y.Doc`. */
export const CANVAS_TEXT_KEY = "content"

/**
 * The transaction origin every update that arrived from a peer is applied
 * under.
 *
 * `onLocalUpdate` treats anything else as local, deliberately. Listing the
 * local origins instead would mean every new way of mutating the document (an
 * editor binding, an AI apply, a plugin write) had to remember to add itself,
 * and the failure mode of forgetting is an edit that never reaches anybody.
 * Inverting it makes the default correct: whatever this device did, it says.
 */
export const CANVAS_REMOTE_ORIGIN = "cognia:canvas:remote"

function persistSessionMetadata(label: string, session: CollaborativeSession): void {
  canvasSessionsDb.upsertSession(session).catch((err) => {
    loggers.canvas.warn(`crdt-store ${label} persist failed`, {
      sessionId: session.id,
      error: String(err),
    })
  })
}

function persistSessionClose(sessionId: string): void {
  canvasSessionsDb.closeSession(sessionId).catch((err) => {
    loggers.canvas.warn("crdt-store close persist failed", {
      sessionId,
      error: String(err),
    })
  })
}

/**
 * A document and the Yjs state that backs it.
 *
 * `content` is a projection kept in step with the `Y.Text`, so every reader
 * that only wants the string (the editor, the store bridge, the preview) does
 * not have to know Yjs exists.
 */
export interface CRDTDocument {
  id: string
  content: string
  /** Monotonic per local application, for change detection only. */
  version: number
  doc: Y.Doc
  text: Y.Text
}

/**
 * One Yjs update, ready for a JSON transport.
 *
 * The old shape carried `position` / `length` / a vector clock, which is what
 * made it impossible to apply safely. A Yjs update is opaque: the receiver
 * hands it to `Y.applyUpdate` and the merge is the library's problem.
 */
export interface CRDTOperation {
  id: string
  /** Base64 of the Yjs binary update. */
  update: string
  origin: string
  timestamp: number
}

export interface CRDTState {
  documents: Map<string, CRDTDocument>
  sessions: Map<string, CollaborativeSession>
  localParticipantId: string | null
}

export class CanvasCRDTStore {
  private documents: Map<string, CRDTDocument> = new Map()
  private sessions: Map<string, CollaborativeSession> = new Map()
  private localParticipantId: string | null = null
  private listeners: Map<string, Set<(update: CollaborationUpdate) => void>> = new Map()
  /** Per document, the callbacks watching for updates this device produced. */
  private localUpdateListeners: Map<string, Set<(operation: CRDTOperation) => void>> = new Map()
  /** Watchers of the session set itself, for surfaces outside the hook that owns it. */
  private sessionListeners: Set<() => void> = new Set()

  setLocalParticipantId(id: string): void {
    this.localParticipantId = id
  }

  private localId(): string {
    return this.localParticipantId || "local"
  }

  /** Who this device is in a session, for a surface that has to find itself. */
  getLocalParticipantId(): string | null {
    return this.localParticipantId
  }

  /** The `Y.Doc` for a session's document, for an editor binding to attach to. */
  getYDoc(sessionId: string): Y.Doc | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    return this.documents.get(session.documentId)?.doc ?? null
  }

  /** The shared text for a session's document, for an editor binding. */
  getYText(sessionId: string): Y.Text | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    return this.documents.get(session.documentId)?.text ?? null
  }

  private ensureDocument(documentId: string, content: string): CRDTDocument {
    const existing = this.documents.get(documentId)
    if (existing) return existing

    const doc = new Y.Doc()
    const text = doc.getText(CANVAS_TEXT_KEY)
    if (content.length > 0) text.insert(0, content)

    const record: CRDTDocument = { id: documentId, content: text.toString(), version: 0, doc, text }
    // One observer keeps the string projection true for every local and remote
    // change, so no caller has to remember to re-read it.
    text.observe(() => {
      record.content = text.toString()
      record.version += 1
    })
    // One place that notices this device changed the document, whoever changed
    // it. Before this, only `applyLocalUpdate` produced an operation to
    // broadcast, and it had no callers: an editor binding, an AI apply or a
    // plugin write reached the `Y.Doc` and stopped there.
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === CANVAS_REMOTE_ORIGIN) return
      const listeners = this.localUpdateListeners.get(documentId)
      if (!listeners?.size) return
      const operation: CRDTOperation = {
        id: `op-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        update: toBase64(update),
        origin: this.localId(),
        timestamp: Date.now(),
      }
      for (const listener of listeners) listener(operation)
    })
    this.documents.set(documentId, record)
    return record
  }

  /**
   * Watch the session set.
   *
   * A session is created by whichever surface called `connect`, which today is
   * the collaboration panel. The editor lives in a different component and has
   * no way to be told. Rather than lift the session into a second state
   * container next to this one, the registry says when it changed and callers
   * read it back with `sessionIdForDocument`.
   */
  onSessionsChanged(listener: () => void): () => void {
    this.sessionListeners.add(listener)
    return () => {
      this.sessionListeners.delete(listener)
    }
  }

  private notifySessionsChanged(): void {
    for (const listener of this.sessionListeners) listener()
  }

  /**
   * The open session for a document, by id.
   *
   * A string rather than the session object, because this is what a
   * `useSyncExternalStore` snapshot compares: returning the object would
   * re-render on every mutation Yjs makes to its participant list.
   */
  sessionIdForDocument(documentId: string): string | null {
    for (const session of this.sessions.values()) {
      if (session.documentId === documentId && session.isActive) return session.id
    }
    return null
  }

  /**
   * Watch for updates this device produced, whatever produced them.
   *
   * The payload is the incremental update Yjs emitted for that transaction,
   * not a diff against a state vector, so a burst of keystrokes is a burst of
   * small frames rather than one growing snapshot.
   */
  onLocalUpdate(sessionId: string, listener: (operation: CRDTOperation) => void): () => void {
    const session = this.sessions.get(sessionId)
    if (!session) return () => {}
    const documentId = session.documentId
    const listeners = this.localUpdateListeners.get(documentId) ?? new Set()
    listeners.add(listener)
    this.localUpdateListeners.set(documentId, listeners)
    return () => {
      const current = this.localUpdateListeners.get(documentId)
      current?.delete(listener)
      if (current && current.size === 0) this.localUpdateListeners.delete(documentId)
    }
  }

  createSession(documentId: string, content: string): CollaborativeSession {
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`

    this.ensureDocument(documentId, content)

    const session: CollaborativeSession = {
      id: sessionId,
      documentId,
      ownerId: this.localId(),
      participants: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      isActive: true,
      permissions: {
        canEdit: true,
        canComment: true,
        canShare: true,
        canExport: true,
      },
    }
    this.sessions.set(sessionId, session)

    persistSessionMetadata("createSession", session)
    this.notifySessionsChanged()

    return session
  }

  joinSession(sessionId: string, participant: Participant): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    const existingIndex = session.participants.findIndex((p) => p.id === participant.id)
    if (existingIndex >= 0) {
      session.participants[existingIndex] = { ...participant, isOnline: true }
    } else {
      session.participants.push({ ...participant, isOnline: true })
    }

    session.updatedAt = new Date()
    persistSessionMetadata("joinSession", session)
    this.notifyListeners(sessionId, {
      type: "participant",
      participantId: participant.id,
      timestamp: new Date(),
      data: { action: "joined", participant },
    })
  }

  leaveSession(sessionId: string, participantId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const participant = session.participants.find((p) => p.id === participantId)
    if (participant) {
      participant.isOnline = false
      participant.lastActive = new Date()
    }

    session.updatedAt = new Date()
    persistSessionMetadata("leaveSession", session)
    this.notifyListeners(sessionId, {
      type: "participant",
      participantId,
      timestamp: new Date(),
      data: { action: "left" },
    })
  }

  /**
   * Apply a local edit and produce the update to broadcast.
   *
   * `replace` is honoured rather than silently degraded. The old
   * `createOperation` mapped anything that was not a delete onto an insert, so
   * a replace inserted the new text and never removed the old.
   */
  applyLocalUpdate(sessionId: string, update: ContentUpdate): CRDTOperation {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    const record = this.documents.get(session.documentId)
    if (!record) throw new Error(`Document ${session.documentId} not found`)

    const before = Y.encodeStateVector(record.doc)
    // One transaction, so a replace reaches every peer as a single update
    // rather than as a delete they might interleave with.
    record.doc.transact(() => {
      const length = record.text.length
      const position = Math.max(0, Math.min(update.position, length))
      if (update.type === "delete" || update.type === "replace") {
        const removable = Math.max(0, Math.min(update.length ?? 0, length - position))
        if (removable > 0) record.text.delete(position, removable)
      }
      if (update.type !== "delete" && update.text) {
        record.text.insert(position, update.text)
      }
    }, this.localId())

    const operation: CRDTOperation = {
      id: `op-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      update: toBase64(Y.encodeStateAsUpdate(record.doc, before)),
      origin: this.localId(),
      timestamp: Date.now(),
    }

    this.notifyListeners(sessionId, {
      type: "content",
      participantId: this.localId(),
      timestamp: new Date(),
      data: operation,
    })

    return operation
  }

  /**
   * Merge a peer's update.
   *
   * Nothing is dropped. The old causal gate refused any operation it judged
   * "too far ahead" and had no buffer to hold it, so a reordered delivery was
   * lost permanently and the two documents never converged again. Yjs merges
   * out-of-order updates by construction.
   *
   * A malformed payload is reported and ignored rather than thrown, because it
   * arrives from the network and one bad frame must not tear down the session.
   */
  applyRemoteUpdate(sessionId: string, operation: CRDTOperation): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const record = this.documents.get(session.documentId)
    if (!record) return

    try {
      // The sentinel, not the peer's id: it is what `onLocalUpdate` filters on,
      // and relaying a peer's update straight back to them is how a room of
      // three starts echoing.
      Y.applyUpdate(record.doc, fromBase64(operation.update), CANVAS_REMOTE_ORIGIN)
    } catch (err) {
      loggers.canvas.warn("crdt remote update rejected", {
        sessionId,
        origin: operation.origin,
        error: String(err),
      })
      return
    }

    this.notifyListeners(sessionId, {
      type: "content",
      participantId: operation.origin,
      timestamp: new Date(),
      data: operation,
    })
  }

  /**
   * Everything this peer knows about a document, as one update.
   *
   * What a joining client is sent, and what replaces the old `serializeState`:
   * a state snapshot rather than a session object plus an operation log, so
   * receiving it cannot install a session or a participant list.
   */
  encodeSnapshot(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    const record = this.documents.get(session.documentId)
    if (!record) return null
    return toBase64(Y.encodeStateAsUpdate(record.doc))
  }

  /** Merge a snapshot from a peer into an existing session's document. */
  applySnapshot(sessionId: string, snapshot: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const record = this.documents.get(session.documentId)
    if (!record) return false
    try {
      Y.applyUpdate(record.doc, fromBase64(snapshot), CANVAS_REMOTE_ORIGIN)
      return true
    } catch (err) {
      loggers.canvas.warn("crdt snapshot rejected", { sessionId, error: String(err) })
      return false
    }
  }

  updateCursor(sessionId: string, participantId: string, cursor: CursorPosition): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const participant = session.participants.find((p) => p.id === participantId)
    if (participant) {
      participant.cursor = cursor
      this.notifyListeners(sessionId, {
        type: "cursor",
        participantId,
        timestamp: new Date(),
        data: cursor,
      })
    }
  }

  getDocumentContent(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null

    const doc = this.documents.get(session.documentId)
    return doc?.content ?? null
  }

  getSession(sessionId: string): CollaborativeSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Adopt a session the caller has already authorised, with the content it
   * loaded. Idempotent, so re-joining does not reset a document that is
   * already open and possibly ahead of what the caller read.
   */
  adoptSession(session: CollaborativeSession, content: string): void {
    this.ensureDocument(session.documentId, content)
    if (!this.sessions.has(session.id)) this.sessions.set(session.id, session)
  }

  subscribe(sessionId: string, callback: (update: CollaborationUpdate) => void): () => void {
    if (!this.listeners.has(sessionId)) {
      this.listeners.set(sessionId, new Set())
    }
    this.listeners.get(sessionId)!.add(callback)

    return () => {
      this.listeners.get(sessionId)?.delete(callback)
    }
  }

  private notifyListeners(sessionId: string, update: CollaborationUpdate): void {
    const listeners = this.listeners.get(sessionId)
    if (listeners) {
      for (const callback of listeners) {
        callback(update)
      }
    }
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.isActive = false
      this.sessions.delete(sessionId)
      // Destroying the doc releases its observers. Leaving it would keep the
      // whole history alive for the life of the tab.
      this.documents.get(session.documentId)?.doc.destroy()
      this.documents.delete(session.documentId)
      this.listeners.delete(sessionId)
      this.localUpdateListeners.delete(session.documentId)
      persistSessionClose(sessionId)
      this.notifySessionsChanged()
    }
  }

  /**
   * Pull the most-recent persisted sessions back into memory, so the UI can
   * list previous collab sessions on startup. It does NOT reopen the WebSocket
   * transport, which is the hook layer's job.
   */
  async restoreRecentSessions(limit = 20): Promise<CollaborativeSession[]> {
    try {
      const sessions = await canvasSessionsDb.listRecent(limit)
      for (const s of sessions) {
        if (!this.sessions.has(s.id)) {
          this.sessions.set(s.id, s)
        }
      }
      return sessions
    } catch (err) {
      loggers.canvas.warn("crdt-store restoreRecentSessions failed", {
        error: String(err),
      })
      return []
    }
  }
}

export const crdtStore = new CanvasCRDTStore()

export default CanvasCRDTStore
