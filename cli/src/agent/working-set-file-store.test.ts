/** @jest-environment node */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { WorkingSetConflictError } from "@/lib/chat/working-set"
import { runWorkingSetTool } from "@/lib/claude/working-set-tool"

import { workingSetPath } from "./session-store/paths"
import { createFileWorkingSetStore, type WorkingSetFs } from "./working-set-file-store"

let home: string

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "cli-working-set-"))
})

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

const fact = (summary: string) => ({ kind: "fact" as const, summary, origin: "agent" as const })

describe("createFileWorkingSetStore", () => {
  it("reads an empty working set for a CLI session that has none yet", async () => {
    // LC-03: the Dexie store answered "Unknown chat session" for every CLI id.
    const store = createFileWorkingSetStore({ home })
    await expect(store.read("s_mvbrjq5pdblgr8")).resolves.toMatchObject({
      revision: 0,
      entries: [],
    })
  })

  it("persists a revisioned mutation that a fresh store reads back", async () => {
    const store = createFileWorkingSetStore({ home })
    const next = await store.mutate({
      sessionId: "s1",
      expectedRevision: 0,
      action: "upsert",
      entry: { ...fact("task code QUARTZ-HERON-6932"), id: "code" },
      now: 10,
    })
    expect(next.revision).toBe(1)
    const reread = await createFileWorkingSetStore({ home }).read("s1")
    expect(reread).toEqual(next)
    expect(JSON.parse(await fs.readFile(workingSetPath(home, "s1"), "utf8"))).toEqual(next)
  })

  it("enforces compare-and-swap on the revision", async () => {
    const store = createFileWorkingSetStore({ home })
    await store.mutate({ sessionId: "s1", expectedRevision: 0, action: "upsert", entry: fact("a") })
    await expect(
      store.mutate({ sessionId: "s1", expectedRevision: 0, action: "upsert", entry: fact("b") })
    ).rejects.toBeInstanceOf(WorkingSetConflictError)
  })

  it("serialises parallel mutations so exactly one wins the same revision", async () => {
    // Two upserts the model sent in one step, against two store instances.
    const a = createFileWorkingSetStore({ home })
    const b = createFileWorkingSetStore({ home })
    const results = await Promise.allSettled([
      a.mutate({ sessionId: "s1", expectedRevision: 0, action: "upsert", entry: fact("x") }),
      b.mutate({ sessionId: "s1", expectedRevision: 0, action: "upsert", entry: fact("y") }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1)
    expect((await a.read("s1")).revision).toBe(1)
  })

  it("resolves and removes entries through the shared rules", async () => {
    const store = createFileWorkingSetStore({ home })
    await store.mutate({
      sessionId: "s1",
      expectedRevision: 0,
      action: "upsert",
      entry: { ...fact("a"), id: "e1" },
    })
    const resolved = await store.mutate({
      sessionId: "s1",
      expectedRevision: 1,
      action: "resolve",
      entryId: "e1",
    })
    expect(resolved.entries[0]?.status).toBe("resolved")
    const removed = await store.mutate({
      sessionId: "s1",
      expectedRevision: 2,
      action: "remove",
      entryId: "e1",
    })
    expect(removed.entries).toEqual([])
    await expect(
      store.mutate({ sessionId: "s1", expectedRevision: 3, action: "remove", entryId: "e1" })
    ).rejects.toThrow(/Unknown working set entry/)
  })

  it("reports a damaged file instead of silently resetting it", async () => {
    const file = workingSetPath(home, "s1")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "{not json")
    const store = createFileWorkingSetStore({ home })
    await expect(store.read("s1")).rejects.toThrow(/not valid JSON/)
    await fs.writeFile(file, JSON.stringify({ revision: 1 }))
    await expect(store.read("s1")).rejects.toThrow(/unknown shape/)
    await expect(
      store.mutate({ sessionId: "s1", expectedRevision: 1, action: "upsert", entry: fact("a") })
    ).rejects.toThrow(/unknown shape/)
  })

  it("rejects an unsafe session id before touching the disk", async () => {
    const writes: string[] = []
    const fsx: WorkingSetFs = {
      readFile: async () => null,
      writeFileAtomic: async (p) => {
        writes.push(p)
      },
    }
    const store = createFileWorkingSetStore({ home, fsx })
    await expect(store.read("../escape")).rejects.toThrow(/invalid session id/)
    await expect(
      store.mutate({
        sessionId: "../escape",
        expectedRevision: 0,
        action: "upsert",
        entry: fact("a"),
      })
    ).rejects.toThrow(/invalid session id/)
    expect(writes).toEqual([])
  })

  it("serves the shared working_set tool end to end", async () => {
    const store = createFileWorkingSetStore({ home })
    const ctx = { sessionId: "s_cli" }
    await expect(runWorkingSetTool({ action: "get" }, ctx, store)).resolves.toMatchObject({
      ok: true,
      workingSet: { revision: 0 },
    })
    await expect(
      runWorkingSetTool(
        { action: "upsert", expectedRevision: 0, entry: fact("keep the code") },
        ctx,
        store
      )
    ).resolves.toMatchObject({ ok: true, workingSet: { revision: 1 } })
    await expect(
      runWorkingSetTool({ action: "upsert", expectedRevision: 0, entry: fact("stale") }, ctx, store)
    ).resolves.toMatchObject({ ok: false, code: "revision_conflict", revision: 1 })
  })
})
