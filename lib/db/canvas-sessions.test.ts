/** @jest-environment jsdom */
/**
 * Tests for lib/db/canvas-sessions.ts (schema v11+ canvasSessions table).
 */

import "fake-indexeddb/auto"
import {
  bulkImport,
  closeSession,
  deleteSession,
  getActiveSessionForDocument,
  getSession,
  listAll,
  listRecent,
  upsertSession,
  __TESTING__,
} from "./canvas-sessions"
import type { CollaborativeSession, Participant } from "@/types/canvas/collaboration"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function makeParticipant(overrides: Partial<Participant> = {}): Participant {
  return {
    id: overrides.id ?? "user_1",
    name: overrides.name ?? "Maya",
    color: overrides.color ?? "#3b82f6",
    lastActive: overrides.lastActive ?? new Date(1000),
    isOnline: overrides.isOnline ?? true,
  }
}

function makeSession(overrides: Partial<CollaborativeSession> = {}): CollaborativeSession {
  return {
    id: overrides.id ?? "sess_1",
    documentId: overrides.documentId ?? "doc_1",
    ownerId: overrides.ownerId ?? "user_1",
    participants: overrides.participants ?? [makeParticipant()],
    createdAt: overrides.createdAt ?? new Date(1000),
    updatedAt: overrides.updatedAt ?? new Date(2000),
    isActive: overrides.isActive ?? true,
    shareLink: overrides.shareLink,
    permissions: overrides.permissions ?? {
      canEdit: true,
      canComment: true,
      canShare: true,
      canExport: true,
    },
  }
}

describe("canvas-sessions CRUD", () => {
  it("upsertSession persists; getSession reads back as runtime CollaborativeSession", async () => {
    const s = makeSession()
    await upsertSession(s)
    const reloaded = await getSession("sess_1")
    expect(reloaded?.id).toBe("sess_1")
    expect(reloaded?.documentId).toBe("doc_1")
    expect(reloaded?.createdAt).toBeInstanceOf(Date)
    expect(reloaded?.participants).toHaveLength(1)
    expect(reloaded?.participants[0].lastActive).toBeInstanceOf(Date)
  })

  it("upsertSession is idempotent (put semantics)", async () => {
    await upsertSession(makeSession({ id: "sess_1", isActive: true }))
    await upsertSession(makeSession({ id: "sess_1", isActive: false }))
    const reloaded = await getSession("sess_1")
    expect(reloaded?.isActive).toBe(false)
  })

  it("getSession returns undefined for missing id", async () => {
    expect(await getSession("missing")).toBeUndefined()
  })

  it("getActiveSessionForDocument prefers most-recent active row", async () => {
    await upsertSession(
      makeSession({ id: "old", documentId: "doc_1", createdAt: new Date(1000), isActive: true })
    )
    await upsertSession(
      makeSession({ id: "new", documentId: "doc_1", createdAt: new Date(2000), isActive: true })
    )
    await upsertSession(
      makeSession({
        id: "other_doc",
        documentId: "doc_2",
        createdAt: new Date(3000),
        isActive: true,
      })
    )
    const active = await getActiveSessionForDocument("doc_1")
    expect(active?.id).toBe("new")
  })

  it("getActiveSessionForDocument ignores inactive sessions", async () => {
    await upsertSession(makeSession({ id: "closed", documentId: "doc_1", isActive: false }))
    expect(await getActiveSessionForDocument("doc_1")).toBeUndefined()
  })

  it("closeSession flips isActive=false but keeps the row", async () => {
    await upsertSession(makeSession({ id: "sess_1", isActive: true }))
    await closeSession("sess_1")
    const reloaded = await getSession("sess_1")
    expect(reloaded?.isActive).toBe(false)
    expect(reloaded?.updatedAt).toBeInstanceOf(Date)
  })

  it("listRecent returns newest-first and respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await upsertSession(makeSession({ id: `s${i}`, createdAt: new Date(1000 + i) }))
    }
    const all = await listRecent()
    expect(all.map((s) => s.id)).toEqual(["s4", "s3", "s2", "s1", "s0"])
    const top2 = await listRecent(2)
    expect(top2).toHaveLength(2)
    expect(top2[0].id).toBe("s4")
  })

  it("listRecent with limit <= 0 returns all", async () => {
    await upsertSession(makeSession({ id: "s1" }))
    await upsertSession(makeSession({ id: "s2" }))
    expect(await listRecent(0)).toHaveLength(2)
  })

  it("deleteSession removes the row", async () => {
    await upsertSession(makeSession({ id: "sess_1" }))
    await deleteSession("sess_1")
    expect(await getSession("sess_1")).toBeUndefined()
  })

  it("bulkImport inserts new rows; skips existing ids; returns count", async () => {
    const a = makeSession({ id: "sess_a" })
    const b = makeSession({ id: "sess_b" })
    expect(await bulkImport([a, b])).toBe(2)
    expect(await bulkImport([a])).toBe(0)
    expect(await bulkImport([])).toBe(0)
  })

  it("listAll returns every session", async () => {
    await upsertSession(makeSession({ id: "s1" }))
    await upsertSession(makeSession({ id: "s2" }))
    expect(await listAll()).toHaveLength(2)
  })

  it("serializeParticipants emits ISO strings; deserializeParticipants restores Date", () => {
    const p = makeParticipant({ lastActive: new Date(1234) })
    const json = __TESTING__.serializeParticipants([p])
    expect(json).toContain("1970-01-01T00:00:01.234Z")
    const round = __TESTING__.deserializeParticipants(json)
    expect(round[0].lastActive).toBeInstanceOf(Date)
    expect(round[0].lastActive.getTime()).toBe(1234)
  })

  it("deserializeParticipants tolerates undefined / invalid JSON", () => {
    expect(__TESTING__.deserializeParticipants(undefined)).toEqual([])
    expect(__TESTING__.deserializeParticipants("not-json")).toEqual([])
  })

  it("toRow / fromRow round-trip preserves Date and participants", () => {
    const original = makeSession({ id: "sess_x" })
    const row = __TESTING__.toRow(original)
    expect(row.createdAt).toBe(1000)
    expect(row.updatedAt).toBe(2000)
    expect(typeof row.participants).toBe("string")
    const round = __TESTING__.fromRow(row)
    expect(round.id).toBe("sess_x")
    expect(round.createdAt.getTime()).toBe(1000)
    expect(round.participants[0].name).toBe("Maya")
  })
})
