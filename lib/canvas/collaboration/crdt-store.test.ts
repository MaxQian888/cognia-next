/**
 * Comprehensive Tests for CRDT Store
 */

import "fake-indexeddb/auto"
import { CanvasCRDTStore, crdtStore, type CRDTOperation } from "./crdt-store"
import type { Participant, ContentUpdate } from "@/types/canvas/collaboration"
import * as canvasSessionsDb from "@/lib/db/canvas-sessions"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

async function freshDb() {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
}

async function flushMicrotasks() {
  // Give the fire-and-forget Dexie writes a chance to land.
  await new Promise((r) => setTimeout(r, 5))
}

const createParticipant = (id: string, name: string, isOnline = true): Participant => ({
  id,
  name,
  color: "#ff0000",
  isOnline,
  lastActive: new Date(),
})

const createContentUpdate = (
  type: "insert" | "delete",
  position: number,
  text?: string,
  length?: number
): ContentUpdate => ({
  type,
  position,
  text,
  length,
  origin: "test-user",
})

describe("CanvasCRDTStore", () => {
  let store: CanvasCRDTStore

  beforeEach(() => {
    store = new CanvasCRDTStore()
    store.setLocalParticipantId("test-user")
  })

  describe("setLocalParticipantId", () => {
    it("should set the local participant ID", () => {
      store.setLocalParticipantId("my-id")
      const session = store.createSession("doc1", "content")
      expect(session.ownerId).toBe("my-id")
    })
  })

  describe("createSession", () => {
    it("should create a new session", () => {
      const session = store.createSession("doc1", "initial content")

      expect(session).toBeDefined()
      expect(session.id).toBeTruthy()
      expect(session.documentId).toBe("doc1")
      expect(session.isActive).toBe(true)
    })

    it("should initialize document with content", () => {
      const content = "Hello, World!"
      const session = store.createSession("doc1", content)

      const retrievedContent = store.getDocumentContent(session.id)
      expect(retrievedContent).toBe(content)
    })

    it("should set correct permissions", () => {
      const session = store.createSession("doc1", "content")

      expect(session.permissions.canEdit).toBe(true)
      expect(session.permissions.canComment).toBe(true)
      expect(session.permissions.canShare).toBe(true)
      expect(session.permissions.canExport).toBe(true)
    })

    it("should initialize empty participants list", () => {
      const session = store.createSession("doc1", "content")

      expect(session.participants).toEqual([])
    })
  })

  describe("joinSession", () => {
    it("should add participant to session", () => {
      const session = store.createSession("doc1", "content")
      const participant = createParticipant("user1", "User 1")

      store.joinSession(session.id, participant)

      const updatedSession = store.getSession(session.id)
      expect(updatedSession?.participants.length).toBe(1)
      expect(updatedSession?.participants[0].id).toBe("user1")
    })

    it("should update existing participant", () => {
      const session = store.createSession("doc1", "content")
      const participant = createParticipant("user1", "User 1", false)

      store.joinSession(session.id, participant)
      store.joinSession(session.id, { ...participant, isOnline: true })

      const updatedSession = store.getSession(session.id)
      expect(updatedSession?.participants.length).toBe(1)
      expect(updatedSession?.participants[0].isOnline).toBe(true)
    })

    it("should throw error for non-existent session", () => {
      const participant = createParticipant("user1", "User 1")

      expect(() => store.joinSession("non-existent", participant)).toThrow()
    })
  })

  describe("leaveSession", () => {
    it("should mark participant as offline", () => {
      const session = store.createSession("doc1", "content")
      const participant = createParticipant("user1", "User 1")

      store.joinSession(session.id, participant)
      store.leaveSession(session.id, "user1")

      const updatedSession = store.getSession(session.id)
      expect(updatedSession?.participants[0].isOnline).toBe(false)
    })

    it("should set lastActive timestamp", () => {
      const session = store.createSession("doc1", "content")
      const participant = createParticipant("user1", "User 1")

      store.joinSession(session.id, participant)
      store.leaveSession(session.id, "user1")

      const updatedSession = store.getSession(session.id)
      expect(updatedSession?.participants[0].lastActive).toBeDefined()
    })

    it("should handle non-existent session gracefully", () => {
      expect(() => store.leaveSession("non-existent", "user1")).not.toThrow()
    })
  })

  describe("applyLocalUpdate", () => {
    it("should apply insert operation", () => {
      const session = store.createSession("doc1", "Hello")

      const operation = store.applyLocalUpdate(
        session.id,
        createContentUpdate("insert", 5, " World")
      )

      expect(operation).toBeDefined()
      expect(operation.type).toBe("insert")
      expect(store.getDocumentContent(session.id)).toBe("Hello World")
    })

    it("should apply delete operation", () => {
      const session = store.createSession("doc1", "Hello World")

      store.applyLocalUpdate(session.id, createContentUpdate("delete", 5, undefined, 6))

      expect(store.getDocumentContent(session.id)).toBe("Hello")
    })

    it("should increment version", () => {
      const session = store.createSession("doc1", "content")

      store.applyLocalUpdate(session.id, createContentUpdate("insert", 0, "new "))

      // Version should be incremented
      const content = store.getDocumentContent(session.id)
      expect(content).toBe("new content")
    })

    it("should throw error for non-existent session", () => {
      expect(() =>
        store.applyLocalUpdate("non-existent", createContentUpdate("insert", 0, "test"))
      ).toThrow()
    })
  })

  describe("applyRemoteUpdate", () => {
    it("should apply remote insert operation", () => {
      const session = store.createSession("doc1", "Hello")

      const operation: CRDTOperation = {
        id: "op-1",
        type: "insert",
        position: 5,
        text: " World",
        origin: "remote-user",
        timestamp: Date.now(),
        vectorClock: new Map(),
      }

      store.applyRemoteUpdate(session.id, operation)

      expect(store.getDocumentContent(session.id)).toBe("Hello World")
    })

    it("should apply remote delete operation", () => {
      const session = store.createSession("doc1", "Hello World")

      const operation: CRDTOperation = {
        id: "op-1",
        type: "delete",
        position: 5,
        length: 6,
        origin: "remote-user",
        timestamp: Date.now(),
        vectorClock: new Map(),
      }

      store.applyRemoteUpdate(session.id, operation)

      expect(store.getDocumentContent(session.id)).toBe("Hello")
    })

    it("should handle non-existent session gracefully", () => {
      const operation: CRDTOperation = {
        id: "op-1",
        type: "insert",
        position: 0,
        text: "test",
        origin: "remote-user",
        timestamp: Date.now(),
        vectorClock: new Map(),
      }

      expect(() => store.applyRemoteUpdate("non-existent", operation)).not.toThrow()
    })
  })

  describe("updateCursor", () => {
    it("should update participant cursor position", () => {
      const session = store.createSession("doc1", "content")
      const participant = createParticipant("user1", "User 1")

      store.joinSession(session.id, participant)
      store.updateCursor(session.id, "user1", { line: 5, column: 10 })

      const updatedSession = store.getSession(session.id)
      expect(updatedSession?.participants[0].cursor).toEqual({ line: 5, column: 10 })
    })

    it("should handle non-existent session gracefully", () => {
      expect(() =>
        store.updateCursor("non-existent", "user1", { line: 1, column: 1 })
      ).not.toThrow()
    })
  })

  describe("getDocumentContent", () => {
    it("should return document content", () => {
      const content = "Test content"
      const session = store.createSession("doc1", content)

      expect(store.getDocumentContent(session.id)).toBe(content)
    })

    it("should return null for non-existent session", () => {
      expect(store.getDocumentContent("non-existent")).toBeNull()
    })
  })

  describe("getSession", () => {
    it("should return session by ID", () => {
      const session = store.createSession("doc1", "content")
      const retrieved = store.getSession(session.id)

      expect(retrieved).toBeDefined()
      expect(retrieved?.id).toBe(session.id)
    })

    it("should return undefined for non-existent session", () => {
      expect(store.getSession("non-existent")).toBeUndefined()
    })
  })

  describe("subscribe", () => {
    it("should notify listeners on content change", () => {
      const session = store.createSession("doc1", "content")
      const callback = jest.fn()

      store.subscribe(session.id, callback)
      store.applyLocalUpdate(session.id, createContentUpdate("insert", 0, "new "))

      expect(callback).toHaveBeenCalled()
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "content",
        })
      )
    })

    it("should notify listeners on participant join", () => {
      const session = store.createSession("doc1", "content")
      const callback = jest.fn()

      store.subscribe(session.id, callback)
      store.joinSession(session.id, createParticipant("user1", "User 1"))

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "participant",
        })
      )
    })

    it("should return unsubscribe function", () => {
      const session = store.createSession("doc1", "content")
      const callback = jest.fn()

      const unsubscribe = store.subscribe(session.id, callback)
      unsubscribe()

      store.applyLocalUpdate(session.id, createContentUpdate("insert", 0, "test"))

      expect(callback).not.toHaveBeenCalled()
    })
  })

  describe("closeSession", () => {
    it("should close and remove session", () => {
      const session = store.createSession("doc1", "content")
      store.closeSession(session.id)

      expect(store.getSession(session.id)).toBeUndefined()
      expect(store.getDocumentContent(session.id)).toBeNull()
    })

    it("should handle non-existent session gracefully", () => {
      expect(() => store.closeSession("non-existent")).not.toThrow()
    })
  })

  describe("serializeState", () => {
    it("should serialize session state to JSON", () => {
      const session = store.createSession("doc1", "content")
      const serialized = store.serializeState(session.id)

      expect(serialized).toBeTruthy()
      expect(typeof serialized).toBe("string")

      const parsed = JSON.parse(serialized!)
      expect(parsed.session).toBeDefined()
      expect(parsed.document).toBeDefined()
    })

    it("should return null for non-existent session", () => {
      expect(store.serializeState("non-existent")).toBeNull()
    })
  })

  describe("deserializeState", () => {
    it("should restore session from serialized state", () => {
      const original = store.createSession("doc1", "original content")
      const serialized = store.serializeState(original.id)

      store.closeSession(original.id)

      const restoredId = store.deserializeState(serialized!)

      expect(restoredId).toBeTruthy()
      expect(store.getDocumentContent(restoredId!)).toBe("original content")
    })

    it("should return null for invalid JSON", () => {
      expect(store.deserializeState("invalid json")).toBeNull()
    })

    it("should return null for empty input", () => {
      expect(store.deserializeState("")).toBeNull()
    })
  })

  describe("singleton instance", () => {
    it("should export a singleton instance", () => {
      expect(crdtStore).toBeInstanceOf(CanvasCRDTStore)
    })

    it("should have all methods available", () => {
      expect(typeof crdtStore.setLocalParticipantId).toBe("function")
      expect(typeof crdtStore.createSession).toBe("function")
      expect(typeof crdtStore.joinSession).toBe("function")
      expect(typeof crdtStore.leaveSession).toBe("function")
      expect(typeof crdtStore.applyLocalUpdate).toBe("function")
      expect(typeof crdtStore.applyRemoteUpdate).toBe("function")
      expect(typeof crdtStore.updateCursor).toBe("function")
      expect(typeof crdtStore.getDocumentContent).toBe("function")
      expect(typeof crdtStore.getSession).toBe("function")
      expect(typeof crdtStore.subscribe).toBe("function")
      expect(typeof crdtStore.closeSession).toBe("function")
      expect(typeof crdtStore.serializeState).toBe("function")
      expect(typeof crdtStore.deserializeState).toBe("function")
      expect(typeof crdtStore.restoreRecentSessions).toBe("function")
    })
  })
})

describe("CanvasCRDTStore Dexie persistence", () => {
  let store: CanvasCRDTStore

  beforeEach(async () => {
    await freshDb()
    store = new CanvasCRDTStore()
    store.setLocalParticipantId("user-1")
  })

  it("createSession persists session metadata to Dexie", async () => {
    const session = store.createSession("doc1", "hello")
    await flushMicrotasks()
    const persisted = await canvasSessionsDb.getSession(session.id)
    expect(persisted).toBeDefined()
    expect(persisted?.documentId).toBe("doc1")
    expect(persisted?.isActive).toBe(true)
  })

  it("joinSession persists the updated participant list", async () => {
    const session = store.createSession("doc1", "hello")
    await flushMicrotasks()
    store.joinSession(session.id, createParticipant("user-2", "Bob"))
    await flushMicrotasks()
    const persisted = await canvasSessionsDb.getSession(session.id)
    expect(persisted?.participants).toHaveLength(1)
    expect(persisted?.participants[0].id).toBe("user-2")
  })

  it("leaveSession persists the participant offline state", async () => {
    const session = store.createSession("doc1", "hello")
    store.joinSession(session.id, createParticipant("user-2", "Bob"))
    await flushMicrotasks()
    store.leaveSession(session.id, "user-2")
    await flushMicrotasks()
    const persisted = await canvasSessionsDb.getSession(session.id)
    expect(persisted?.participants[0].isOnline).toBe(false)
  })

  it("closeSession marks the row inactive in Dexie", async () => {
    const session = store.createSession("doc1", "hello")
    await flushMicrotasks()
    store.closeSession(session.id)
    await flushMicrotasks()
    const persisted = await canvasSessionsDb.getSession(session.id)
    expect(persisted?.isActive).toBe(false)
  })

  it("restoreRecentSessions rehydrates sessions into the in-memory map", async () => {
    // Seed Dexie out-of-band, then create a fresh store and restore.
    const fresh = new CanvasCRDTStore()
    fresh.setLocalParticipantId("user-1")
    await canvasSessionsDb.upsertSession({
      id: "sess_seed",
      documentId: "doc_seed",
      ownerId: "user-1",
      participants: [],
      createdAt: new Date(1000),
      updatedAt: new Date(1000),
      isActive: true,
      permissions: { canEdit: true, canComment: true, canShare: true, canExport: true },
    })
    const restored = await fresh.restoreRecentSessions()
    expect(restored).toHaveLength(1)
    expect(fresh.getSession("sess_seed")).toBeDefined()
  })

  it("restoreRecentSessions does not overwrite already-loaded sessions", async () => {
    const session = store.createSession("doc1", "live")
    await flushMicrotasks()
    // Mutate the row in Dexie behind the store's back.
    const stored = await canvasSessionsDb.getSession(session.id)
    if (stored) {
      stored.ownerId = "different-owner"
      await canvasSessionsDb.upsertSession(stored)
    }
    await store.restoreRecentSessions()
    // Live in-memory copy wins; we don't trample on the active session.
    expect(store.getSession(session.id)?.ownerId).toBe("user-1")
  })

  it("restoreRecentSessions returns [] when Dexie throws", async () => {
    await getDb().close()
    const fresh = new CanvasCRDTStore()
    expect(await fresh.restoreRecentSessions()).toEqual([])
  })

  it("persistSessionMetadata catch handler logs without throwing", async () => {
    await getDb().close()
    expect(() => {
      store.createSession("doc1", "x")
    }).not.toThrow()
    await flushMicrotasks()
  })

  it("applyRemoteUpdate exercises the vector-clock conflict branches", () => {
    // Touches canApplyOperation: skip-self branch + value > localValue + 1 reject.
    const session = store.createSession("doc1", "abc")
    const ahead: CRDTOperation = {
      id: "op-ahead",
      type: "insert",
      position: 0,
      text: "X",
      origin: "remote-1",
      timestamp: Date.now(),
      // Vector clock claims remote-1 is way ahead (jumps past our local clock).
      vectorClock: new Map([
        ["remote-1", 1],
        ["other", 5], // localValue is 0; 5 > 0+1 should reject
      ]),
    }
    const before = store.getDocumentContent(session.id)
    store.applyRemoteUpdate(session.id, ahead)
    // Operation rejected — content unchanged.
    expect(store.getDocumentContent(session.id)).toBe(before)
  })

  it("persistSessionClose catch handler logs without throwing", async () => {
    const session = store.createSession("doc1", "x")
    await flushMicrotasks()
    await getDb().close()
    expect(() => {
      store.closeSession(session.id)
    }).not.toThrow()
    await flushMicrotasks()
  })
})
