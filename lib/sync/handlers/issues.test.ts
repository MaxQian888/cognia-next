/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

import { RETRIEVAL_CONTENT_PROTOCOL_VERSION } from "./base"
import { reviveProject, syncIssues, syncLabels, syncProjects } from "./issues"

function makeTransport(rows: unknown[], deleted_ids: string[] = [], next_since = 1): Transport {
  return {
    call: jest.fn(async () => ({ rows, deleted_ids, next_since })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

const wireProject = (id: string) => ({
  id,
  name: `Workspace ${id}`,
  roots: [],
  knowledgeBase: [],
  sessionIds: [],
  sessionCount: 0,
  messageCount: 0,
  createdAt: 1_000,
  updatedAt: 2_000,
  lastAccessedAt: 3_000,
})

const issue = (id: string) => ({
  id,
  projectId: "ws1",
  issueProjectId: "c1",
  identifier: `ENG-${id}`,
  title: `Issue ${id}`,
  status: "todo",
  statusCategory: "unstarted",
  labelIds: [],
  createdAt: 1,
  updatedAt: 20,
})

describe("syncProjects", () => {
  it("revives the timestamps the wire flattened to epoch ms", () => {
    // JSON has no Date. Persisting the numbers would leave rows whose type
    // promises `Date`, which fails at the first `.getTime()` in the
    // workspace switcher's sort. Asserted on the pure function: a value read
    // back out of fake-indexeddb is structured-cloned into another realm, so
    // `instanceof` there tests the test harness rather than this code.
    const revived = reviveProject(wireProject("ws9"))
    expect(revived.updatedAt).toBeInstanceOf(Date)
    expect(revived.updatedAt.getTime()).toBe(2_000)
    expect(revived.lastAccessedAt.getTime()).toBe(3_000)
    expect(revived.createdAt.getTime()).toBe(1_000)
    expect(revived).toMatchObject({ id: "ws9", name: "Workspace ws9", roots: [] })
  })

  it("stores a date-shaped value rather than the raw epoch number", async () => {
    const out = await syncProjects(makeTransport([wireProject("ws1")]), { since: 0 })
    expect(out.ok).toBe(true)

    const stored = await getDb().projects.get("ws1")
    expect(typeof stored?.updatedAt).not.toBe("number")
    expect(new Date(stored!.updatedAt).getTime()).toBe(2_000)
    expect(new Date(stored!.lastAccessedAt).getTime()).toBe(3_000)
  })

  it("removes a workspace the host tombstoned", async () => {
    await syncProjects(makeTransport([wireProject("gone")]), { since: 0 })
    await syncProjects(makeTransport([], ["gone"]), { since: 0 })
    expect(await getDb().projects.get("gone")).toBeUndefined()
  })
})

describe("syncIssues", () => {
  it("pulls the board with the given cursor", async () => {
    const tx = makeTransport([], [], 7)
    const out = await syncIssues(tx, { since: 42 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "issues",
      since: 42,
      content_protocol_version: RETRIEVAL_CONTENT_PROTOCOL_VERSION,
    })
    expect(out.ok).toBe(true)
  })

  it("writes rows the mobile board can group", async () => {
    const out = await syncIssues(makeTransport([issue("a"), issue("b")]), { since: 0 })
    expect(out.ok).toBe(true)
    expect((await getDb().issues.toArray()).map((row) => row.id).sort()).toEqual(["a", "b"])
  })
})

describe("syncLabels", () => {
  it("mirrors the catalogue every chip resolves against", async () => {
    const out = await syncLabels(
      makeTransport([
        { id: "l1", scope: "issue", name: "bug", color: "red", builtin: false, updatedAt: 5 },
      ]),
      { since: 0 }
    )
    expect(out.ok).toBe(true)
    expect(await getDb().labels.get("l1")).toMatchObject({ name: "bug" })
  })
})
