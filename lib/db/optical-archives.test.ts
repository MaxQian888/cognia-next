/** @jest-environment jsdom */
// Coverage for the opticalArchives CRUD module — save/replace, per-session and
// global newest-first listing, get/delete/clear, and cap pruning. Uses
// fake-indexeddb so we exercise the real Dexie query path in memory.

import "fake-indexeddb/auto"
import {
  saveOpticalArchive,
  listOpticalArchives,
  getOpticalArchive,
  deleteOpticalArchive,
  clearOpticalArchives,
  __TESTING__,
  type OpticalArchiveRow,
} from "./optical-archives"
import { getDb, whenSeeded, __resetDbForTesting } from "./schema"

// The Dexie schema is at v101; a cold open crosses Jest's 5s default hook
// timeout (worse under coverage instrumentation). Mirror the repo pattern for
// high-version tables.
jest.setTimeout(30_000)

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function makeRow(over: Partial<OpticalArchiveRow> = {}): OpticalArchiveRow {
  return {
    id: over.id ?? `b_${Math.random().toString(36).slice(2)}`,
    sessionId: over.sessionId ?? "s1",
    createdAt: over.createdAt ?? 1,
    strategy: "optical",
    preTokens: over.preTokens ?? 4000,
    postTokens: over.postTokens ?? 400,
    frameCount: 1,
    frames: [{ base64: "AAAA", width: 512, height: 64 }],
    shape: { font: "8x8", variant: "bw", size: 512 },
    coverage: 1,
    readability: 0.9,
    originalText: "user: hello\nassistant: world",
    ...over,
  }
}

describe("saveOpticalArchive", () => {
  it("persists a row keyed by boundary id and reads it back", async () => {
    await saveOpticalArchive(makeRow({ id: "boundary-1" }))
    const row = await getOpticalArchive("boundary-1")
    expect(row?.strategy).toBe("optical")
    expect(row?.frames[0].base64).toBe("AAAA")
    expect(row?.originalText).toContain("hello")
  })

  it("replaces an existing row with the same id (idempotent boundary)", async () => {
    await saveOpticalArchive(makeRow({ id: "b", postTokens: 400 }))
    await saveOpticalArchive(makeRow({ id: "b", postTokens: 123 }))
    expect((await getOpticalArchive("b"))?.postTokens).toBe(123)
    expect(await getDb().opticalArchives.count()).toBe(1)
  })

  it("prunes oldest rows beyond the cap", async () => {
    const cap = __TESTING__.ARCHIVE_CAP
    for (let i = 0; i < cap + 5; i++) {
      await saveOpticalArchive(makeRow({ id: `b${i}`, createdAt: i + 1 }))
    }
    expect(await getDb().opticalArchives.count()).toBe(cap)
    const remaining = await getDb().opticalArchives.orderBy("createdAt").toArray()
    expect(remaining[0].createdAt).toBeGreaterThan(5)
  })
})

describe("listOpticalArchives", () => {
  beforeEach(async () => {
    await saveOpticalArchive(makeRow({ id: "a1", sessionId: "s1", createdAt: 1 }))
    await saveOpticalArchive(makeRow({ id: "a2", sessionId: "s1", createdAt: 2 }))
    await saveOpticalArchive(makeRow({ id: "b1", sessionId: "s2", createdAt: 3 }))
  })

  it("lists all archives newest-first", async () => {
    const rows = await listOpticalArchives()
    expect(rows.map((r) => r.id)).toEqual(["b1", "a2", "a1"])
  })

  it("scopes to a session newest-first", async () => {
    const rows = await listOpticalArchives({ sessionId: "s1" })
    expect(rows.map((r) => r.id)).toEqual(["a2", "a1"])
  })

  it("respects a positive limit", async () => {
    expect(await listOpticalArchives({ limit: 1 })).toHaveLength(1)
    expect(await listOpticalArchives({ limit: 0 })).toHaveLength(3)
  })
})

describe("delete / clear", () => {
  it("deletes a single row by id", async () => {
    await saveOpticalArchive(makeRow({ id: "x" }))
    await deleteOpticalArchive("x")
    expect(await getOpticalArchive("x")).toBeUndefined()
  })

  it("clears one session, leaving others intact", async () => {
    await saveOpticalArchive(makeRow({ id: "a", sessionId: "s1" }))
    await saveOpticalArchive(makeRow({ id: "b", sessionId: "s2" }))
    await clearOpticalArchives("s1")
    expect(await getOpticalArchive("a")).toBeUndefined()
    expect(await getOpticalArchive("b")).toBeDefined()
  })

  it("clears everything when no session is given", async () => {
    await saveOpticalArchive(makeRow({ id: "a", sessionId: "s1" }))
    await saveOpticalArchive(makeRow({ id: "b", sessionId: "s2" }))
    await clearOpticalArchives()
    expect(await getDb().opticalArchives.count()).toBe(0)
  })
})
