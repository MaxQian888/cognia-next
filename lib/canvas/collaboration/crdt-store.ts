/**
 * CRDT Store - Conflict-free Replicated Data Type for collaborative editing
 * Uses a simplified CRDT implementation for real-time document synchronization
 */

import type {
  CollaborativeSession,
  Participant,
  CursorPosition,
  ContentUpdate,
  CollaborationUpdate,
} from "@/types/canvas/collaboration"
import * as canvasSessionsDb from "@/lib/db/canvas-sessions"
import { loggers } from "@/lib/logging"

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

export interface CRDTDocument {
  id: string
  content: string
  version: number
  vectorClock: Map<string, number>
  operations: CRDTOperation[]
}

export interface CRDTOperation {
  id: string
  type: "insert" | "delete"
  position: number
  text?: string
  length?: number
  origin: string
  timestamp: number
  vectorClock: Map<string, number>
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

  setLocalParticipantId(id: string): void {
    this.localParticipantId = id
  }

  createSession(documentId: string, content: string): CollaborativeSession {
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`

    const doc: CRDTDocument = {
      id: documentId,
      content,
      version: 0,
      vectorClock: new Map(),
      operations: [],
    }
    this.documents.set(documentId, doc)

    const session: CollaborativeSession = {
      id: sessionId,
      documentId,
      ownerId: this.localParticipantId || "unknown",
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

  applyLocalUpdate(sessionId: string, update: ContentUpdate): CRDTOperation {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    const doc = this.documents.get(session.documentId)
    if (!doc) throw new Error(`Document ${session.documentId} not found`)

    const operation = this.createOperation(doc, update)
    this.applyOperation(doc, operation)

    this.notifyListeners(sessionId, {
      type: "content",
      participantId: this.localParticipantId || "unknown",
      timestamp: new Date(),
      data: operation,
    })

    return operation
  }

  applyRemoteUpdate(sessionId: string, operation: CRDTOperation): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const doc = this.documents.get(session.documentId)
    if (!doc) return

    if (this.canApplyOperation(doc, operation)) {
      this.applyOperation(doc, operation)
      this.notifyListeners(sessionId, {
        type: "content",
        participantId: operation.origin,
        timestamp: new Date(),
        data: operation,
      })
    }
  }

  private createOperation(doc: CRDTDocument, update: ContentUpdate): CRDTOperation {
    const vectorClock = new Map(doc.vectorClock)
    const localId = this.localParticipantId || "local"
    vectorClock.set(localId, (vectorClock.get(localId) || 0) + 1)

    return {
      id: `op-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: update.type === "delete" ? "delete" : "insert",
      position: update.position,
      text: update.text,
      length: update.length,
      origin: localId,
      timestamp: Date.now(),
      vectorClock,
    }
  }

  private applyOperation(doc: CRDTDocument, operation: CRDTOperation): void {
    if (operation.type === "insert" && operation.text) {
      doc.content =
        doc.content.slice(0, operation.position) +
        operation.text +
        doc.content.slice(operation.position)
    } else if (operation.type === "delete" && operation.length) {
      doc.content =
        doc.content.slice(0, operation.position) +
        doc.content.slice(operation.position + operation.length)
    }

    doc.version++
    doc.operations.push(operation)

    for (const [key, value] of operation.vectorClock) {
      const current = doc.vectorClock.get(key) || 0
      doc.vectorClock.set(key, Math.max(current, value))
    }
  }

  private canApplyOperation(doc: CRDTDocument, operation: CRDTOperation): boolean {
    for (const [key, value] of operation.vectorClock) {
      if (key === operation.origin) continue
      const localValue = doc.vectorClock.get(key) || 0
      if (value > localValue + 1) return false
    }
    return true
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
    return doc?.content || null
  }

  getSession(sessionId: string): CollaborativeSession | undefined {
    return this.sessions.get(sessionId)
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
      this.documents.delete(session.documentId)
      this.listeners.delete(sessionId)
      persistSessionClose(sessionId)
    }
  }

  /**
   * Pull the most-recent persisted sessions back into memory. Used on app
   * startup so the UI can list previous collab sessions; does NOT
   * re-establish the WebSocket transport — that's the hook layer's job.
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

  serializeState(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null

    const doc = this.documents.get(session.documentId)
    if (!doc) return null

    return JSON.stringify({
      session,
      document: {
        ...doc,
        vectorClock: Array.from(doc.vectorClock.entries()),
      },
    })
  }

  deserializeState(data: string): string | null {
    try {
      const parsed = JSON.parse(data)
      const { session, document } = parsed

      const doc: CRDTDocument = {
        ...document,
        vectorClock: new Map(document.vectorClock),
      }

      this.documents.set(doc.id, doc)
      this.sessions.set(session.id, session)

      return session.id
    } catch (err) {
      loggers.canvas.error("crdt deserialize failed", {
        error: String(err),
        preview: data.slice(0, 200),
      })
      return null
    }
  }
}

export const crdtStore = new CanvasCRDTStore()

export default CanvasCRDTStore
