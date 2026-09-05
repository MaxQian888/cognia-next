/** @jest-environment jsdom */
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
  type: ContentUpdate["type"],
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

      expect(operation.update).toBeTruthy()
      expect(store.getDocumentContent(session.id)).toBe("Hello World")
    })

    it("should apply delete operation", () => {
      const session = store.createSession("doc1", "Hello World")

      store.applyLocalUpdate(session.id, createContentUpdate("delete", 5, undefined, 6))

      expect(store.getDocumentContent(session.id)).toBe("Hello")
    })

    it("honours a replace instead of silently inserting", () => {
      // The old `createOperation` mapped anything that was not a delete onto an
      // insert, so a replace added the new text and left the old text in place.
      const session = store.createSession("doc1", "Hello World")

      store.applyLocalUpdate(session.id, createContentUpdate("replace", 6, "There", 5))

      expect(store.getDocumentContent(session.id)).toBe("Hello There")
    })

    it("clamps a position past the end of the document", () => {
      const session = store.createSession("doc1", "abc")
      store.applyLocalUpdate(session.id, createContentUpdate("insert", 999, "!"))
      expect(store.getDocumentContent(session.id)).toBe("abc!")
    })

    it("should throw error for non-existent session", () => {
      expect(() =>
        store.applyLocalUpdate("non-existent", createContentUpdate("insert", 0, "test"))
      ).toThrow()
    })
  })

  describe("applyRemoteUpdate", () => {
    /**
     * A second peer joined to `local`, the way a real joiner starts: with an
     * empty document, seeded from the opener's snapshot. Two peers that each
     * typed the same text independently do NOT share item identities, so their
     * updates cannot line up, and that is a property of any real CRDT rather
     * than a defect.
     */
    function joinedPeer(local: { id: string; documentId: string }) {
      const peer = new CanvasCRDTStore()
      peer.setLocalParticipantId("peer")
      const session = peer.createSession(local.documentId, "")
      peer.applySnapshot(session.id, store.encodeSnapshot(local.id)!)
      return { peer, session }
    }

    it("merges a peer's insert", () => {
      const session = store.createSession("doc1", "Hello")
      const { peer, session: peerSession } = joinedPeer(session)

      const operation = peer.applyLocalUpdate(
        peerSession.id,
        createContentUpdate("insert", 5, " World")
      )
      store.applyRemoteUpdate(session.id, operation)

      expect(store.getDocumentContent(session.id)).toBe("Hello World")
    })

    it("merges a peer's delete", () => {
      const session = store.createSession("doc1", "Hello World")
      const { peer, session: peerSession } = joinedPeer(session)

      const operation = peer.applyLocalUpdate(
        peerSession.id,
        createContentUpdate("delete", 5, undefined, 6)
      )
      store.applyRemoteUpdate(session.id, operation)

      expect(store.getDocumentContent(session.id)).toBe("Hello")
    })

    it("converges when both sides insert at the same position", () => {
      // The whole point. The old implementation spliced each peer's raw index
      // into the receiver's already-mutated string, so both documents ended up
      // different and nothing detected it.
      const local = store.createSession("doc1", "0123456789")
      const { peer, session: remote } = joinedPeer(local)

      const mine = store.applyLocalUpdate(local.id, createContentUpdate("insert", 5, "AAA"))
      const theirs = peer.applyLocalUpdate(remote.id, createContentUpdate("insert", 5, "BBB"))

      store.applyRemoteUpdate(local.id, theirs)
      peer.applyRemoteUpdate(remote.id, mine)

      expect(store.getDocumentContent(local.id)).toBe(peer.getDocumentContent(remote.id))
    })

    it("converges when an update arrives out of order", () => {
      // The old causal gate DROPPED an operation it judged too far ahead, with
      // no buffer and no retry, so the two sides never converged again.
      const local = store.createSession("doc1", "start")
      const { peer, session: remote } = joinedPeer(local)

      const first = peer.applyLocalUpdate(remote.id, createContentUpdate("insert", 5, "-one"))
      const second = peer.applyLocalUpdate(remote.id, createContentUpdate("insert", 9, "-two"))

      // Delivered backwards.
      store.applyRemoteUpdate(local.id, second)
      store.applyRemoteUpdate(local.id, first)

      expect(store.getDocumentContent(local.id)).toBe(peer.getDocumentContent(remote.id))
    })

    it("applying the same update twice changes nothing", () => {
      const local = store.createSession("doc1", "abc")
      const { peer, session: remote } = joinedPeer(local)

      const operation = peer.applyLocalUpdate(remote.id, createContentUpdate("insert", 3, "!"))
      store.applyRemoteUpdate(local.id, operation)
      store.applyRemoteUpdate(local.id, operation)

      expect(store.getDocumentContent(local.id)).toBe(peer.getDocumentContent(remote.id))
    })

    it("ignores a malformed payload instead of tearing down the session", () => {
      const session = store.createSession("doc1", "abc")

      expect(() =>
        store.applyRemoteUpdate(session.id, {
          id: "bad",
          update: "not-base64-yjs!!!",
          origin: "attacker",
          timestamp: Date.now(),
        })
      ).not.toThrow()
      expect(store.getDocumentContent(session.id)).toBe("abc")
    })

    it("should handle non-existent session gracefully", () => {
      expect(() =>
        store.applyRemoteUpdate("non-existent", {
          id: "op-1",
          update: "",
          origin: "remote-user",
          timestamp: Date.now(),
        })
      ).not.toThrow()
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

  describe("snapshots", () => {
    it("encodes a document as opaque state, not as a session object", () => {
      // `serializeState` used to emit `{ session, document }` with the whole
      // operation log, and that JSON went into the share link.
      const session = store.createSession("doc1", "content")
      const snapshot = store.encodeSnapshot(session.id)

      expect(typeof snapshot).toBe("string")
      expect(snapshot).not.toContain("participants")
      expect(snapshot).not.toContain(session.id)
    })

    it("returns null for a session it does not have", () => {
      expect(store.encodeSnapshot("non-existent")).toBeNull()
    })

    it("merges a snapshot into a session it is already in", () => {
      const local = store.createSession("doc1", "")
      const peer = new CanvasCRDTStore()
      peer.setLocalParticipantId("peer")
      const remote = peer.createSession("doc1", "from the peer")

      expect(store.applySnapshot(local.id, peer.encodeSnapshot(remote.id)!)).toBe(true)
      expect(store.getDocumentContent(local.id)).toBe("from the peer")
    })

    it("cannot install a session, only merge into one that exists", () => {
      // `deserializeState` would `JSON.parse` a frame and write whatever
      // session, participants and permissions it described. Any inbound frame
      // typed "sync" could therefore replace the session.
      const peer = new CanvasCRDTStore()
      const remote = peer.createSession("doc1", "x")

      expect(store.applySnapshot(remote.id, peer.encodeSnapshot(remote.id)!)).toBe(false)
      expect(store.getSession(remote.id)).toBeUndefined()
    })

    it("refuses a payload that is not a Yjs update", () => {
      const session = store.createSession("doc1", "keep me")
      expect(store.applySnapshot(session.id, "}{ not base64")).toBe(false)
      expect(store.getDocumentContent(session.id)).toBe("keep me")
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
      expect(typeof crdtStore.encodeSnapshot).toBe("function")
      expect(typeof crdtStore.applySnapshot).toBe("function")
      expect(typeof crdtStore.adoptSession).toBe("function")
      expect(typeof crdtStore.getYText).toBe("function")
      expect(typeof crdtStore.restoreRecentSessions).toBe("function")
    })

    it("no longer exposes a JSON state sink", () => {
      // `deserializeState` parsed attacker-supplied JSON and installed the
      // session, participants and permissions it described. It was reachable
      // from a share link and from any inbound frame typed "sync".
      const legacy = crdtStore as unknown as Record<string, unknown>
      expect(legacy.deserializeState).toBeUndefined()
      expect(legacy.serializeState).toBeUndefined()
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

  it("holds an update it cannot place yet, instead of dropping it", () => {
    // The old causal gate REFUSED anything it judged too far ahead and had no
    // buffer, so a reordered delivery was lost and the two sides never
    // converged again. Yjs keeps it pending until the state it depends on
    // arrives, and then applies both.
    const local = store.createSession("doc1", "abc")
    const peer = new CanvasCRDTStore()
    peer.setLocalParticipantId("peer")
    const remote = peer.createSession("doc1", "")
    peer.applySnapshot(remote.id, store.encodeSnapshot(local.id)!)

    const first = peer.applyLocalUpdate(remote.id, createContentUpdate("insert", 3, "-one"))
    const second = peer.applyLocalUpdate(remote.id, createContentUpdate("insert", 7, "-two"))

    // The dependent update arrives first and cannot be placed yet.
    store.applyRemoteUpdate(local.id, second)
    expect(store.getDocumentContent(local.id)).toBe("abc")

    // Its predecessor lands, and both take effect.
    store.applyRemoteUpdate(local.id, first)
    expect(store.getDocumentContent(local.id)).toBe(peer.getDocumentContent(remote.id))
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
