/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import {
  createMemory,
  getMemory,
  invalidateMemory,
  updateMemory,
  type MemoryCreateInput,
} from "@/lib/db/memories"
import type { ManageMemoryCommand } from "@/lib/memory/control-plane/manage"
import { applyMirroredMemoryCommand } from "./mirror-memory"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function row(overrides: Partial<MemoryCreateInput>): MemoryCreateInput {
  return {
    scope: "global",
    type: "semantic",
    text: "fact",
    tags: [],
    importance: 5,
    pinned: false,
    provenance: "user",
    ...overrides,
  }
}

async function mirrorAudits(memoryId: string) {
  return (await getDb().memoryAuditEvents.toArray()).filter(
    (event) => event.memoryId === memoryId && event.reason === "mirror"
  )
}

describe("applyMirroredMemoryCommand", () => {
  it("pins and audits the mirror move", async () => {
    await createMemory(row({ id: "m1" }))
    await expect(
      applyMirroredMemoryCommand({ kind: "pin", id: "m1", pinned: true })
    ).resolves.toEqual({ ok: true })
    expect((await getMemory("m1"))?.pinned).toBe(true)
    expect((await mirrorAudits("m1")).map((event) => event.action)).toEqual(["pinned"])
  })

  it("edits text with a version bump and no local revision snapshot", async () => {
    await createMemory(row({ id: "m1", text: "old" }))
    await applyMirroredMemoryCommand({
      kind: "update",
      id: "m1",
      patch: { text: "  new  ", tags: ["t"], importance: 8 },
    })
    const got = await getMemory("m1")
    expect(got).toMatchObject({ text: "new", tags: ["t"], importance: 8, version: 2 })
    expect(
      await getDb()
        .memories.filter((m) => m.revisionOf === "m1")
        .count()
    ).toBe(0)
  })

  it("archives, restores and moves rows the way the host will", async () => {
    await createMemory(row({ id: "m1", scope: "character", characterId: "c1" }))
    await applyMirroredMemoryCommand({ kind: "invalidate", id: "m1" })
    expect((await getMemory("m1"))?.status).toBe("invalidated")
    await applyMirroredMemoryCommand({ kind: "restore", id: "m1" })
    expect((await getMemory("m1"))?.status).toBe("active")
    await applyMirroredMemoryCommand({
      kind: "relocate",
      id: "m1",
      target: { scope: "workspace", projectId: "p1" },
    })
    expect(await getMemory("m1")).toMatchObject({ scope: "workspace", projectId: "p1" })
    expect((await getMemory("m1"))?.characterId).toBeUndefined()
    // One audit per step. Audit ids are random and the three can share a
    // millisecond, so the order is the state checks' to prove, not the store's.
    expect((await mirrorAudits("m1")).map((event) => event.action).sort()).toEqual([
      "invalidated",
      "relocated",
      "restored",
    ])
  })

  it("records a review decision", async () => {
    await createMemory(row({ id: "m1" }))
    await applyMirroredMemoryCommand({ kind: "review", id: "m1", status: "conflict" })
    expect((await getMemory("m1"))?.reviewStatus).toBe("conflict")
  })

  it("drops a deleted row and its snapshots without writing a tombstone", async () => {
    await createMemory(row({ id: "m1", text: "first" }))
    await updateMemory("m1", { text: "second", bumpVersion: true })
    expect(
      await getDb()
        .memories.filter((m) => m.revisionOf === "m1")
        .count()
    ).toBe(1)
    const tombstonesBefore = await getDb().syncTombstones.count()
    await applyMirroredMemoryCommand({ kind: "delete", id: "m1" })
    expect(await getMemory("m1")).toBeUndefined()
    expect(
      await getDb()
        .memories.filter((m) => m.revisionOf === "m1")
        .count()
    ).toBe(0)
    expect(await getDb().syncTombstones.count()).toBe(tombstonesBefore)
  })

  it("clears only the rows a query matches", async () => {
    await createMemory(row({ id: "keep" }))
    await createMemory(row({ id: "gone" }))
    await invalidateMemory("gone")
    await applyMirroredMemoryCommand({ kind: "clear", query: { status: "invalidated" } })
    expect(await getMemory("gone")).toBeUndefined()
    expect(await getMemory("keep")).toBeDefined()
  })

  it.each(["keep", "merge"] as const)(
    "resolves a conflict (%s) by verifying the winner and archiving the loser",
    async (mode) => {
      await createMemory(
        row({ id: "a", text: "tea", reviewStatus: "conflict", conflictWithIds: ["b"] })
      )
      await createMemory(
        row({ id: "b", text: "coffee", reviewStatus: "conflict", conflictWithIds: ["a"] })
      )
      await applyMirroredMemoryCommand({
        kind: "resolve-conflict",
        keepId: "a",
        dropId: "b",
        mode,
        ...(mode === "merge" ? { mergedText: "tea and coffee" } : {}),
      })
      const keep = await getMemory("a")
      expect(keep).toMatchObject({ reviewStatus: "verified", conflictWithIds: [] })
      if (mode === "merge") expect(keep?.text).toBe("tea and coffee")
      expect(await getMemory("b")).toMatchObject({ status: "invalidated", supersededById: "a" })
    }
  )

  it("keeps both sides of a conflict live when asked", async () => {
    await createMemory(row({ id: "a", reviewStatus: "conflict", conflictWithIds: ["b"] }))
    await createMemory(row({ id: "b", reviewStatus: "conflict", conflictWithIds: ["a"] }))
    await applyMirroredMemoryCommand({
      kind: "resolve-conflict",
      keepId: "a",
      dropId: "b",
      mode: "keep-both",
    })
    expect(await getMemory("b")).toMatchObject({ status: "active", reviewStatus: "verified" })
  })

  const deferred: ManageMemoryCommand[] = [
    { kind: "create", text: "x", type: "semantic", importance: 5, tags: [] },
    { kind: "restore-revision", id: "m1", revisionId: "s1" },
    { kind: "retrieval-feedback", id: "m1", verdict: "helpful" },
  ]
  it.each(deferred)("defers $kind to the host's answer", async (command) => {
    await expect(applyMirroredMemoryCommand(command)).resolves.toEqual({
      ok: true,
      reason: "deferred",
    })
  })

  it("never throws when the mirror write fails", async () => {
    const spy = jest.spyOn(getDb().memories, "update").mockRejectedValueOnce(new Error("quota"))
    await expect(
      applyMirroredMemoryCommand({ kind: "review", id: "m1", status: "verified" })
    ).resolves.toEqual({ ok: false, reason: "failed" })
    spy.mockRestore()
  })
})
