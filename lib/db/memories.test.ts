import type { Memory } from "@/types/memory/memory"
import { createDbTestFixture } from "./test-fixture"
import { getDb } from "./schema"
import {
  ACCESS_BUMP_COOLDOWN_MS,
  clearMemories,
  countActive,
  createMemory,
  getMemoriesByVectorDocIds,
  getMemory,
  hardDeleteMemories,
  hardDeleteMemory,
  invalidateMemory,
  listActiveForReader,
  listActiveProcedural,
  listHistoricalForReader,
  listMemories,
  listMemoriesBySourceMessageId,
  listMemoryRevisions,
  recordRetrievalFeedback,
  restoreMemoryRevision,
  setMemoriesPinned,
  setMemoryPinned,
  touchMemories,
  updateMemory,
  type MemoryCreateInput,
} from "./memories"

function buildInput(overrides: Partial<MemoryCreateInput> = {}): MemoryCreateInput {
  return {
    scope: "global",
    type: "semantic",
    text: "The user prefers pnpm",
    tags: [],
    importance: 5,
    pinned: false,
    provenance: "user",
    ...overrides,
  }
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("memories CRUD", () => {
  it("createMemory stamps defaults and timestamps", async () => {
    const before = Date.now()
    const row = await createMemory(buildInput({ id: "m1" }))
    const after = Date.now()
    expect(row.id).toBe("m1")
    expect(row.status).toBe("active")
    expect(row.version).toBe(1)
    expect(row.accessCount).toBe(0)
    expect(row.createdAt).toBeGreaterThanOrEqual(before)
    expect(row.createdAt).toBeLessThanOrEqual(after)
    expect(row.updatedAt).toBe(row.createdAt)
    expect(row.lastAccessedAt).toBe(row.createdAt)
  })

  it("createMemory generates an id when none is supplied", async () => {
    const row = await createMemory(buildInput())
    expect(row.id).toMatch(/^mem_\d+_[a-z0-9]+$/)
  })

  it("createMemory defaults tags and pinned when omitted", async () => {
    const row = await createMemory({
      scope: "global",
      type: "semantic",
      text: "x",
      importance: 1,
      provenance: "user",
    } as MemoryCreateInput)
    expect(row.tags).toEqual([])
    expect(row.pinned).toBe(false)
  })

  it("getMemory round-trips", async () => {
    await createMemory(buildInput({ id: "m1" }))
    const got = await getMemory("m1")
    expect(got?.text).toBe("The user prefers pnpm")
    expect(await getMemory("missing")).toBeUndefined()
  })

  it("updateMemory bumps updatedAt and applies the patch", async () => {
    const row = await createMemory(buildInput({ id: "m1" }))
    await new Promise((r) => setTimeout(r, 2))
    await updateMemory("m1", { text: "changed", tags: ["t"] })
    const got = await getMemory("m1")
    expect(got?.text).toBe("changed")
    expect(got?.tags).toEqual(["t"])
    expect(got?.updatedAt).toBeGreaterThan(row.updatedAt)
    expect(got?.version).toBe(1) // not bumped without bumpVersion
  })

  it("updateMemory bumps version when bumpVersion is set", async () => {
    await createMemory(buildInput({ id: "m1" }))
    await updateMemory("m1", { text: "v2", bumpVersion: true })
    expect((await getMemory("m1"))?.version).toBe(2)
    await updateMemory("m1", { text: "v3", bumpVersion: true })
    expect((await getMemory("m1"))?.version).toBe(3)
  })

  it("invalidateMemory soft-deletes and preserves the row", async () => {
    await createMemory(buildInput({ id: "m1" }))
    await invalidateMemory("m1", "m2")
    const got = await getMemory("m1")
    expect(got?.status).toBe("invalidated")
    expect(got?.invalidatedAt).toBeGreaterThan(0)
    expect(got?.supersededById).toBe("m2")
  })

  it("invalidateMemory without supersededById leaves it unset", async () => {
    await createMemory(buildInput({ id: "m1" }))
    await invalidateMemory("m1")
    expect((await getMemory("m1"))?.supersededById).toBeUndefined()
  })

  it("listMemoriesBySourceMessageId returns that message's rows newest-first, incl. invalidated", async () => {
    await createMemory(buildInput({ id: "m1", sourceMessageId: "msg-a", createdAt: 1000 }))
    await createMemory(buildInput({ id: "m2", sourceMessageId: "msg-a", createdAt: 2000 }))
    await createMemory(buildInput({ id: "m3", sourceMessageId: "msg-b" }))
    await createMemory(buildInput({ id: "m4" }))
    await invalidateMemory("m1")

    const rows = await listMemoriesBySourceMessageId("msg-a")
    expect(rows.map((m) => m.id)).toEqual(["m2", "m1"])
    expect(rows[1].status).toBe("invalidated")
    expect(await listMemoriesBySourceMessageId("")).toEqual([])
    expect(await listMemoriesBySourceMessageId("missing")).toEqual([])
  })
})

describe("touch / pin", () => {
  it("touchMemories bumps lastAccessedAt and accessCount", async () => {
    const row = await createMemory(buildInput({ id: "m1" }))
    await new Promise((r) => setTimeout(r, 2))
    await touchMemories(["m1", "missing"])
    const got = await getMemory("m1")
    expect(got?.accessCount).toBe(1)
    expect(got?.lastAccessedAt).toBeGreaterThan(row.lastAccessedAt)
  })

  it("touchMemories is a no-op on empty input", async () => {
    await expect(touchMemories([])).resolves.toBeUndefined()
  })

  it("setMemoryPinned toggles pinned", async () => {
    await createMemory(buildInput({ id: "m1" }))
    await setMemoryPinned("m1", true)
    expect((await getMemory("m1"))?.pinned).toBe(true)
    await setMemoryPinned("m1", false)
    expect((await getMemory("m1"))?.pinned).toBe(false)
  })
})

describe("listing & scope-union", () => {
  async function seed() {
    await createMemory(buildInput({ id: "g1", scope: "global", type: "semantic" }))
    await createMemory(buildInput({ id: "g2", scope: "global", type: "procedural" }))
    await createMemory(
      buildInput({ id: "cA", scope: "character", characterId: "charA", type: "semantic" })
    )
    await createMemory(
      buildInput({ id: "cB", scope: "character", characterId: "charB", type: "semantic" })
    )
    await invalidateMemory("g2")
  }

  it("listMemories filters by scope/type/status and sorts newest-first", async () => {
    await seed()
    const globals = await listMemories({ scope: "global" })
    expect(globals.map((m) => m.id).sort()).toEqual(["g1", "g2"])
    const active = await listMemories({ status: "active" })
    expect(active.find((m) => m.id === "g2")).toBeUndefined()
    const proc = await listMemories({ type: "procedural" })
    expect(proc.map((m) => m.id)).toEqual(["g2"])
    const charA = await listMemories({ scope: "character", characterId: "charA" })
    expect(charA.map((m) => m.id)).toEqual(["cA"])
  })

  it("listMemories can match a complete maintenance namespace", async () => {
    await createMemory(buildInput({ id: "p1-root", scope: "workspace", projectId: "p1" }))
    await createMemory(
      buildInput({ id: "p1-branch", scope: "workspace", projectId: "p1", branch: "main" })
    )
    await createMemory(buildInput({ id: "p2-root", scope: "workspace", projectId: "p2" }))

    const rows = await listMemories({
      scope: "workspace",
      status: "active",
      projectId: "p1",
      exactNamespace: true,
    })

    expect(rows.map((memory) => memory.id)).toEqual(["p1-root"])
  })

  it("listActiveForReader unions global with the character's own override layer", async () => {
    await seed()
    const forA = await listActiveForReader("charA")
    expect(forA.map((m) => m.id).sort()).toEqual(["cA", "g1"]) // g2 invalidated, cB other char
    const noChar = await listActiveForReader()
    expect(noChar.map((m) => m.id)).toEqual(["g1"])
  })

  it("layers workspace and character memories over global stable keys", async () => {
    await createMemory(buildInput({ id: "global", key: "package-manager", text: "Use npm" }))
    await createMemory(
      buildInput({
        id: "workspace",
        scope: "workspace",
        projectId: "project-a",
        key: "package-manager",
        text: "Use pnpm",
      })
    )
    await createMemory(
      buildInput({
        id: "character",
        scope: "character",
        characterId: "char-a",
        projectId: "project-a",
        key: "package-manager",
        text: "Use Bun",
      })
    )

    const rows = await listActiveForReader({ projectId: "project-a", characterId: "char-a" })
    expect(
      rows.filter((memory) => memory.key === "package-manager").map((memory) => memory.id)
    ).toEqual(["character"])
  })

  it("keeps agent namespaces private and applies branch/path restrictions", async () => {
    await createMemory(buildInput({ id: "global" }))
    await createMemory(
      buildInput({ id: "agent-a", scope: "agent", agentId: "agent-a", projectId: "p" })
    )
    await createMemory(
      buildInput({ id: "agent-b", scope: "agent", agentId: "agent-b", projectId: "p" })
    )
    await createMemory(
      buildInput({
        id: "path-match",
        scope: "workspace",
        projectId: "p",
        branch: "main",
        pathPattern: "src/features",
      })
    )
    await createMemory(
      buildInput({
        id: "path-miss",
        scope: "workspace",
        projectId: "p",
        branch: "other",
        pathPattern: "src/features",
      })
    )

    const rows = await listActiveForReader({
      projectId: "p",
      agentId: "agent-a",
      branch: "main",
      path: "src/features/memory/panel.tsx",
    })
    expect(rows.map((memory) => memory.id).sort()).toEqual(["agent-a", "global", "path-match"])
  })

  it("retains conflicts for review but excludes them from recall", async () => {
    await createMemory(buildInput({ id: "safe" }))
    await createMemory(buildInput({ id: "conflict", reviewStatus: "conflict" }))
    expect((await listActiveForReader()).map((memory) => memory.id)).toEqual(["safe"])
    expect((await listMemories()).map((memory) => memory.id)).toContain("conflict")
  })

  it("listActiveProcedural returns only active procedural for the reader", async () => {
    await createMemory(buildInput({ id: "p1", type: "procedural" }))
    await createMemory(buildInput({ id: "s1", type: "semantic" }))
    const proc = await listActiveProcedural()
    expect(proc.map((m) => m.id)).toEqual(["p1"])
  })

  it("countActive counts per scope and character", async () => {
    await seed()
    expect(await countActive("global")).toBe(1) // g2 invalidated
    expect(await countActive("character", "charA")).toBe(1)
    expect(await countActive("character")).toBe(2) // both chars
  })

  it("getMemoriesByVectorDocIds maps doc ids to rows", async () => {
    await createMemory(buildInput({ id: "m1", vectorDocId: "v1" }))
    await createMemory(buildInput({ id: "m2", vectorDocId: "v2" }))
    const rows = await getMemoriesByVectorDocIds(["v1", "v2", "vX"])
    expect(rows.map((m) => m.id).sort()).toEqual(["m1", "m2"])
    expect(await getMemoriesByVectorDocIds([])).toEqual([])
  })
})

describe("delete & clear", () => {
  it("hardDeleteMemory cascades evidence and ciphertext while retaining a tombstone and audit", async () => {
    await createMemory(buildInput({ id: "m1" }))
    await getDb().memoryEvidence.add({
      id: "e1",
      memoryId: "m1",
      kind: "message",
      sourceId: "message-1",
      contaminationState: "clean",
      reviewed: false,
      createdAt: 1,
    })
    await hardDeleteMemory("m1")
    expect(await getMemory("m1")).toBeUndefined()
    expect(await getDb().memoryEvidence.where("memoryId").equals("m1").count()).toBe(0)
    expect(await getDb().retrievalTombstones.get("memory:m1")).toMatchObject({
      entityType: "memory",
      entityId: "m1",
    })
    expect(await getDb().memoryAuditEvents.where("memoryId").equals("m1").last()).toMatchObject({
      action: "deleted",
      reason: "user_requested",
    })
  })

  it("clearMemories deletes matching rows and returns the count", async () => {
    await createMemory(buildInput({ id: "g1", scope: "global" }))
    await createMemory(buildInput({ id: "cA", scope: "character", characterId: "charA" }))
    const cleared = await clearMemories({ scope: "global" })
    expect(cleared).toBe(1)
    expect(await getMemory("g1")).toBeUndefined()
    expect(await getMemory("cA")).toBeDefined()
  })

  it("clearMemories returns 0 when nothing matches", async () => {
    expect(await clearMemories({ scope: "global" })).toBe(0)
  })

  it("clearMemories with no query clears everything", async () => {
    await createMemory(buildInput({ id: "g1" }))
    await createMemory(buildInput({ id: "g2" }))
    expect(await clearMemories()).toBe(2)
    expect((await listMemories()).length).toBe(0)
  })

  it("hardDeleteMemories removes the listed rows and returns the count", async () => {
    await createMemory(buildInput({ id: "a" }))
    await createMemory(buildInput({ id: "b" }))
    await createMemory(buildInput({ id: "c" }))
    expect(await hardDeleteMemories(["a", "c"])).toBe(2)
    expect(await getMemory("a")).toBeUndefined()
    expect(await getMemory("b")).toBeDefined()
    expect(await getMemory("c")).toBeUndefined()
  })

  it("hardDeleteMemories is a no-op on empty input", async () => {
    expect(await hardDeleteMemories([])).toBe(0)
  })

  it("setMemoriesPinned pins/unpins the listed rows in one pass", async () => {
    await createMemory(buildInput({ id: "a", pinned: false }))
    await createMemory(buildInput({ id: "b", pinned: false }))
    await setMemoriesPinned(["a", "b"], true)
    expect((await getMemory("a"))?.pinned).toBe(true)
    expect((await getMemory("b"))?.pinned).toBe(true)
    await setMemoriesPinned(["a"], false)
    expect((await getMemory("a"))?.pinned).toBe(false)
    expect((await getMemory("b"))?.pinned).toBe(true)
  })

  it("setMemoriesPinned is a no-op on empty input", async () => {
    await expect(setMemoriesPinned([], true)).resolves.toBeUndefined()
  })
})

// Belt-and-suspenders: the row shape the table stores matches the Memory type.
it("stored row satisfies the Memory contract", async () => {
  const row = await createMemory(buildInput({ id: "m1" }))
  const typed: Memory = row
  expect(typed.id).toBe("m1")
})

describe("recordRetrievalFeedback", () => {
  it("counts a helpful vote without touching updatedAt", async () => {
    // The BM25 corpus cache signature is `${count}:${latest updatedAt}`, so a
    // bump here would re-tokenise every memory on every thumbs-up. This
    // assertion is the only thing that would catch that regression — it is
    // invisible from the type signature and costs nothing until you profile.
    const row = await createMemory(buildInput({ id: "m1" }))
    await new Promise((resolve) => setTimeout(resolve, 2))
    expect(await recordRetrievalFeedback("m1", "helpful", 500)).toBe(true)
    const after = await getMemory("m1")
    expect(after?.retrievalFeedback).toEqual({ positive: 1, negative: 0, lastFeedbackAt: 500 })
    expect(after?.updatedAt).toBe(row.updatedAt)
  })

  it("accumulates across votes", async () => {
    await createMemory(buildInput({ id: "m1" }))
    await recordRetrievalFeedback("m1", "helpful", 1)
    await recordRetrievalFeedback("m1", "helpful", 2)
    await recordRetrievalFeedback("m1", "wrong", 3)
    expect((await getMemory("m1"))?.retrievalFeedback).toEqual({
      positive: 2,
      negative: 1,
      lastFeedbackAt: 3,
    })
  })

  it("marks an outdated memory stale but never conflicted", async () => {
    await createMemory(buildInput({ id: "m1" }))
    await recordRetrievalFeedback("m1", "outdated", 1)
    const after = await getMemory("m1")
    expect(after?.staleness).toBe("stale")
    // `isMemoryEligibleForRetrieval` hard-excludes conflicted rows, so a vote
    // must never produce one — a mis-click would silently and permanently take
    // the memory out of recall from a control with no undo.
    expect(after?.reviewStatus).toBeUndefined()
    expect(after?.status).toBe("active")
  })

  it("leaves a re-check's freshness alone for the other two verdicts", async () => {
    await createMemory(buildInput({ id: "m1" }))
    await updateMemory("m1", { staleness: "fresh" })
    await recordRetrievalFeedback("m1", "wrong", 1)
    expect((await getMemory("m1"))?.staleness).toBe("fresh")
  })

  it("answers false for a memory deleted in another window", async () => {
    expect(await recordRetrievalFeedback("gone", "helpful", 1)).toBe(false)
  })
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 2))

async function onlyRevisionOf(ownerId: string): Promise<Memory> {
  const revisions = await listMemoryRevisions(ownerId)
  expect(revisions).toHaveLength(1)
  return revisions[0]
}

describe("revision snapshots", () => {
  it("preserves the outgoing text as an invalidated snapshot with reason 'edit' by default", async () => {
    const owner = await createMemory(
      buildInput({
        id: "m1",
        text: "old text",
        vectorDocId: "v1",
        key: "pkg",
        sourceMessageId: "msg-1",
        sourceSessionId: "sess-1",
        tags: ["a"],
      })
    )
    await tick()
    await updateMemory("m1", { text: "new text" })

    const live = await getMemory("m1")
    expect(live?.text).toBe("new text")
    expect(live?.revisedAt).toBe(live?.updatedAt)
    expect(live?.version).toBe(1)

    const snapshot = await onlyRevisionOf("m1")
    expect(snapshot.id).not.toBe("m1")
    expect(snapshot).toMatchObject({
      text: "old text",
      status: "invalidated",
      revisionOf: "m1",
      supersededById: "m1",
      revisionReason: "edit",
      invalidatedAt: live?.revisedAt,
      revisedAt: owner.createdAt,
      accessCount: 0,
      pinned: false,
      tags: ["a"],
    })
    expect(snapshot.vectorDocId).toBeUndefined()
    expect(snapshot.key).toBeUndefined()
    expect(snapshot.sourceMessageId).toBeUndefined()
    expect(snapshot.sourceSessionId).toBeUndefined()
  })

  it("records a caller-supplied revisionReason", async () => {
    await createMemory(buildInput({ id: "m1", text: "a" }))
    await updateMemory("m1", { text: "b", revisionReason: "consolidation" })
    expect((await onlyRevisionOf("m1")).revisionReason).toBe("consolidation")
  })

  it("writes no snapshot for a paired device's mirrored edit (skipRevision)", async () => {
    await createMemory(buildInput({ id: "m1", text: "a" }))
    await updateMemory("m1", { text: "b", bumpVersion: true, skipRevision: true })
    expect(await listMemoryRevisions("m1")).toEqual([])
    const live = await getMemory("m1")
    expect(live?.text).toBe("b")
    expect(live?.revisedAt).toBeUndefined()
    expect(live).not.toHaveProperty("skipRevision")
  })

  it("writes no snapshot when the text is unchanged or absent", async () => {
    await createMemory(buildInput({ id: "m1", text: "same" }))
    await updateMemory("m1", { text: "same", tags: ["x"] })
    await updateMemory("m1", { importance: 9 })
    await updateMemory("m1", { importance: 8, bumpVersion: true })
    expect(await listMemoryRevisions("m1")).toEqual([])
    const live = await getMemory("m1")
    expect(live?.revisedAt).toBeUndefined()
    expect(live?.version).toBe(2)
    expect(await listMemories({ includeRevisions: true })).toHaveLength(1)
  })

  it("refuses to edit the text of a snapshot and leaves it untouched", async () => {
    await createMemory(buildInput({ id: "m1", text: "a" }))
    await updateMemory("m1", { text: "b" })
    const snapshot = await onlyRevisionOf("m1")
    await expect(updateMemory(snapshot.id, { text: "rewritten" })).rejects.toThrow(
      "memory_revision_is_immutable"
    )
    expect((await getMemory(snapshot.id))?.text).toBe("a")
    expect(await listMemoryRevisions("m1")).toHaveLength(1)
  })

  it("bumps the live version alongside the snapshot when bumpVersion is set", async () => {
    await createMemory(buildInput({ id: "m1", text: "a" }))
    await updateMemory("m1", { text: "b", bumpVersion: true })
    expect((await getMemory("m1"))?.version).toBe(2)
    // The snapshot keeps the version the preserved text had.
    expect((await onlyRevisionOf("m1")).version).toBe(1)
  })

  it("listMemories hides snapshots by default and includes them on request", async () => {
    await createMemory(buildInput({ id: "m1", text: "a" }))
    await updateMemory("m1", { text: "b" })
    expect((await listMemories()).map((m) => m.id)).toEqual(["m1"])
    expect((await listMemories({ status: "invalidated" })).map((m) => m.id)).toEqual([])
    const all = await listMemories({ includeRevisions: true })
    expect(all).toHaveLength(2)
    expect(all.filter((m) => m.revisionOf === "m1")).toHaveLength(1)
  })

  it("listMemoryRevisions returns only that memory's snapshots, newest first", async () => {
    await createMemory(buildInput({ id: "m1", text: "v1" }))
    await createMemory(buildInput({ id: "m2", text: "other" }))
    await updateMemory("m1", { text: "v2" })
    await tick()
    await updateMemory("m2", { text: "other 2" })
    await tick()
    await updateMemory("m1", { text: "v3" })
    const revisions = await listMemoryRevisions("m1")
    expect(revisions.map((r) => r.text)).toEqual(["v2", "v1"])
    expect(revisions[0].invalidatedAt!).toBeGreaterThan(revisions[1].invalidatedAt!)
    // The second snapshot's live window starts where the first one ended.
    expect(revisions[0].revisedAt).toBe(revisions[1].invalidatedAt)
    expect(await listMemoryRevisions("missing")).toEqual([])
  })
})

describe("restoreMemoryRevision", () => {
  it("puts the earlier text back, bumps version, and preserves the replaced text as 'restore'", async () => {
    await createMemory(buildInput({ id: "m1", text: "original" }))
    await updateMemory("m1", { text: "mistake" })
    const earlier = await onlyRevisionOf("m1")
    await tick()

    const result = await restoreMemoryRevision("m1", earlier.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.memory).toMatchObject({ id: "m1", text: "original", version: 2 })

    const live = await getMemory("m1")
    expect(live).toMatchObject({ text: "original", version: 2 })
    expect(live?.revisedAt).toBe(live?.updatedAt)
    const revisions = await listMemoryRevisions("m1")
    expect(revisions.map((r) => [r.text, r.revisionReason])).toEqual([
      ["mistake", "restore"],
      ["original", "edit"],
    ])
  })

  it("un-compacts the row when restoring the pre-compaction text", async () => {
    await createMemory(buildInput({ id: "m1", text: "long original" }))
    await updateMemory("m1", { text: "short", compactedAt: 100, revisionReason: "compaction" })
    const preCompaction = await onlyRevisionOf("m1")
    expect(preCompaction.compactedAt).toBeUndefined()

    const result = await restoreMemoryRevision("m1", preCompaction.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.memory.compactedAt).toBeUndefined()
    const live = await getMemory("m1")
    expect(live?.text).toBe("long original")
    expect(live?.compactedAt).toBeUndefined()
    // The compacted wording is itself history now, still marked compacted.
    const restoredFrom = (await listMemoryRevisions("m1")).find((r) => r.text === "short")
    expect(restoredFrom?.compactedAt).toBe(100)
  })

  it("keeps compactedAt when the restored text was itself compacted", async () => {
    await createMemory(buildInput({ id: "m1", text: "a" }))
    await updateMemory("m1", { text: "b", compactedAt: 100 })
    await updateMemory("m1", { text: "c" })
    const compacted = (await listMemoryRevisions("m1")).find((r) => r.text === "b")!
    expect((await restoreMemoryRevision("m1", compacted.id)).ok).toBe(true)
    expect((await getMemory("m1"))?.compactedAt).toBe(100)
  })

  it("reports not_found when either row is missing", async () => {
    await createMemory(buildInput({ id: "m1", text: "a" }))
    await updateMemory("m1", { text: "b" })
    const snapshot = await onlyRevisionOf("m1")
    expect(await restoreMemoryRevision("m1", "missing")).toEqual({
      ok: false,
      reason: "not_found",
    })
    expect(await restoreMemoryRevision("missing", snapshot.id)).toEqual({
      ok: false,
      reason: "not_found",
    })
  })

  it("reports not_a_revision for a live row or another memory's snapshot", async () => {
    await createMemory(buildInput({ id: "m1", text: "a" }))
    await createMemory(buildInput({ id: "m2", text: "x" }))
    await updateMemory("m2", { text: "y" })
    const foreign = await onlyRevisionOf("m2")
    expect(await restoreMemoryRevision("m1", "m2")).toEqual({
      ok: false,
      reason: "not_a_revision",
    })
    expect(await restoreMemoryRevision("m1", foreign.id)).toEqual({
      ok: false,
      reason: "not_a_revision",
    })
    expect((await getMemory("m1"))?.text).toBe("a")
  })

  it("reports unchanged when the revision's text is already live, writing nothing", async () => {
    await createMemory(buildInput({ id: "m1", text: "a" }))
    await updateMemory("m1", { text: "b" })
    await updateMemory("m1", { text: "a" })
    const sameText = (await listMemoryRevisions("m1")).find((r) => r.text === "a")!
    expect(await restoreMemoryRevision("m1", sameText.id)).toEqual({
      ok: false,
      reason: "unchanged",
    })
    expect(await listMemoryRevisions("m1")).toHaveLength(2)
    expect((await getMemory("m1"))?.version).toBe(1)
  })
})

describe("listHistoricalForReader", () => {
  it("returns every status visible to the reader, snapshots included, never widening visibility", async () => {
    await createMemory(buildInput({ id: "g1", text: "g old" }))
    await updateMemory("g1", { text: "g new" })
    await createMemory(buildInput({ id: "g2" }))
    await invalidateMemory("g2")
    await createMemory(buildInput({ id: "cA", scope: "character", characterId: "charA" }))
    await createMemory(
      buildInput({ id: "cB", scope: "character", characterId: "charB", text: "b old" })
    )
    await updateMemory("cB", { text: "b new" })
    await createMemory(buildInput({ id: "conflict", reviewStatus: "conflict" }))

    const gSnapshot = await onlyRevisionOf("g1")
    const bSnapshot = await onlyRevisionOf("cB")

    const forA = (await listHistoricalForReader("charA")).map((m) => m.id).sort()
    expect(forA).toEqual(["cA", "g1", "g2", gSnapshot.id].sort())
    expect(forA).not.toContain(bSnapshot.id)

    const forB = (await listHistoricalForReader({ characterId: "charB" })).map((m) => m.id)
    expect(forB).toEqual(expect.arrayContaining(["cB", bSnapshot.id, "g1", gSnapshot.id]))
    expect(forB).not.toContain("cA")

    const anonymous = (await listHistoricalForReader()).map((m) => m.id).sort()
    expect(anonymous).toEqual(["g1", "g2", gSnapshot.id].sort())
  })
})

describe("touchMemories cooldown", () => {
  it("skips a second bump within the cooldown and counts one after it", async () => {
    await createMemory(buildInput({ id: "m1" }))
    const t0 = 10_000_000_000_000
    await touchMemories(["m1"], t0)
    expect(await getMemory("m1")).toMatchObject({ accessCount: 1, lastAccessedAt: t0 })

    await touchMemories(["m1"], t0 + ACCESS_BUMP_COOLDOWN_MS - 1)
    expect(await getMemory("m1")).toMatchObject({ accessCount: 1, lastAccessedAt: t0 })

    await touchMemories(["m1"], t0 + ACCESS_BUMP_COOLDOWN_MS)
    expect(await getMemory("m1")).toMatchObject({
      accessCount: 2,
      lastAccessedAt: t0 + ACCESS_BUMP_COOLDOWN_MS,
    })
  })

  it("always counts the first touch of a never-accessed row, even right after creation", async () => {
    const row = await createMemory(buildInput({ id: "m1" }))
    // lastAccessedAt === createdAt, well inside the cooldown window.
    await touchMemories(["m1"], row.lastAccessedAt + 1)
    expect(await getMemory("m1")).toMatchObject({
      accessCount: 1,
      lastAccessedAt: row.lastAccessedAt + 1,
    })
  })
})

describe("revision-aware delete & clear", () => {
  async function seedWithHistory() {
    await createMemory(buildInput({ id: "m1", text: "v1" }))
    await updateMemory("m1", { text: "v2" })
    await tick()
    await updateMemory("m1", { text: "v3" })
    await createMemory(buildInput({ id: "m2", text: "x1" }))
    await updateMemory("m2", { text: "x2" })
    const m1Revisions = await listMemoryRevisions("m1")
    const m2Revisions = await listMemoryRevisions("m2")
    expect(m1Revisions).toHaveLength(2)
    expect(m2Revisions).toHaveLength(1)
    return { m1Revisions, m2Revisions }
  }

  it("hardDeleteMemories cascades to snapshots, counts owners, tombstones all, audits owners once", async () => {
    const { m1Revisions, m2Revisions } = await seedWithHistory()
    const db = getDb()

    expect(await hardDeleteMemories(["m1"])).toBe(1)

    expect(await getMemory("m1")).toBeUndefined()
    for (const revision of m1Revisions) {
      expect(await getMemory(revision.id)).toBeUndefined()
      expect(await db.retrievalTombstones.get(`memory:${revision.id}`)).toMatchObject({
        entityType: "memory",
        entityId: revision.id,
      })
      expect(await db.memoryAuditEvents.where("memoryId").equals(revision.id).count()).toBe(0)
    }
    expect(await db.retrievalTombstones.get("memory:m1")).toBeDefined()
    const ownerAudits = await db.memoryAuditEvents.where("memoryId").equals("m1").toArray()
    expect(ownerAudits.filter((a) => a.action === "deleted")).toHaveLength(1)

    // The other memory and its history are untouched.
    expect(await getMemory("m2")).toBeDefined()
    expect(await getMemory(m2Revisions[0].id)).toBeDefined()
  })

  it("hardDeleteMemories records `memories` sync tombstones for owners and their snapshots", async () => {
    const { m1Revisions, m2Revisions } = await seedWithHistory()
    const db = getDb()

    await hardDeleteMemories(["m1"])

    const tombstones = await db.syncTombstones.where("table").equals("memories").toArray()
    expect(tombstones.map((row) => row.id).sort()).toEqual(
      ["m1", ...m1Revisions.map((revision) => revision.id)].sort()
    )
    // Owner and snapshots share one watermark.
    expect(new Set(tombstones.map((row) => row.deletedAt)).size).toBe(1)
    // The untouched memory and its history are not tombstoned.
    const tombstoned = new Set(tombstones.map((row) => row.id))
    expect(tombstoned.has("m2")).toBe(false)
    expect(tombstoned.has(m2Revisions[0].id)).toBe(false)
  })

  it("hardDeleteMemories does not double-delete a snapshot listed alongside its owner", async () => {
    const { m1Revisions } = await seedWithHistory()
    const db = getDb()
    expect(await hardDeleteMemories(["m1", m1Revisions[0].id])).toBe(2)
    expect(await listMemoryRevisions("m1")).toEqual([])
    // Listed explicitly, but still history of a deleted owner: no audit row.
    expect(await db.memoryAuditEvents.where("memoryId").equals(m1Revisions[0].id).count()).toBe(0)
  })

  it("clearMemories on a scope reaches snapshots through their owners", async () => {
    const { m1Revisions, m2Revisions } = await seedWithHistory()
    expect(await clearMemories({ scope: "global" })).toBe(2)
    expect(await listMemories({ includeRevisions: true })).toEqual([])
    for (const revision of [...m1Revisions, ...m2Revisions]) {
      expect(await getMemory(revision.id)).toBeUndefined()
    }
  })

  it("clearMemories({ status: 'invalidated' }) drops forgotten memories and all revision history", async () => {
    const { m1Revisions, m2Revisions } = await seedWithHistory()
    await createMemory(buildInput({ id: "forgotten" }))
    await invalidateMemory("forgotten")

    // One forgotten memory plus three snapshots.
    expect(await clearMemories({ status: "invalidated" })).toBe(4)

    expect(await getMemory("forgotten")).toBeUndefined()
    for (const revision of [...m1Revisions, ...m2Revisions]) {
      expect(await getMemory(revision.id)).toBeUndefined()
    }
    expect((await listMemories()).map((m) => m.id).sort()).toEqual(["m1", "m2"])
    expect((await getMemory("m1"))?.text).toBe("v3")
  })
})
