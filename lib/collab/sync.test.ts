/**
 * @jest-environment jsdom
 */

import { listCollabIssues, replaceCollabIssues } from "@/lib/db/collab-issue-mirror"
import { createDbTestFixture } from "@/lib/db/test-fixture"

import { pullCollabIssues, toMirrorRow } from "./sync"

import type { CollabClient, CollabIssue } from "./client"

const ORG = "org_acme00000000000000000"
const ADA = "usr_aaaaaaaaaaaaaaaaaaaaaaaa"

function issue(overrides: Partial<CollabIssue> = {}): CollabIssue {
  return {
    id: "iss_1",
    orgId: ORG,
    workspaceId: "proj-1",
    issueProjectId: "cont-1",
    title: "Ship it",
    status: "todo",
    priority: "medium",
    boardOrder: 1,
    createdBy: { kind: "human", id: ADA },
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  }
}

function clientReturning(issues: CollabIssue[] | (() => Promise<never>)): CollabClient {
  return {
    listIssues: typeof issues === "function" ? issues : async () => issues,
  } as unknown as CollabClient
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("toMirrorRow", () => {
  it("copies the server's shape rather than reshaping it", () => {
    const row = toMirrorRow(
      issue({ body: "details", assignee: { kind: "agent", id: "char_7" } }),
      99
    )
    expect(row).toEqual({
      id: "iss_1",
      orgId: ORG,
      workspaceId: "proj-1",
      issueProjectId: "cont-1",
      title: "Ship it",
      body: "details",
      status: "todo",
      priority: "medium",
      boardOrder: 1,
      assignee: { kind: "agent", id: "char_7" },
      createdBy: { kind: "human", id: ADA },
      createdAt: 10,
      updatedAt: 20,
      fetchedAt: 99,
    })
  })

  it("omits absent optionals rather than writing undefined into an index", () => {
    const row = toMirrorRow(issue(), 1)
    expect("assignee" in row).toBe(false)
    expect("body" in row).toBe(false)
  })
})

describe("pullCollabIssues", () => {
  it("replaces the scope wholesale, so a deleted issue leaves the board", async () => {
    // An upsert would leave it there forever with no way to notice.
    await replaceCollabIssues({ orgId: ORG }, [toMirrorRow(issue({ id: "iss_gone" }), 1)])

    const result = await pullCollabIssues(
      clientReturning([issue({ id: "iss_kept" })]),
      { orgId: ORG },
      { now: () => 500 }
    )

    expect(result).toEqual({ count: 1, fetchedAt: 500 })
    const rows = await listCollabIssues({ orgId: ORG })
    expect(rows.map((row) => row.id)).toEqual(["iss_kept"])
  })

  it("a workspace-scoped pull never deletes another workspace's rows", async () => {
    await replaceCollabIssues({ orgId: ORG }, [
      toMirrorRow(issue({ id: "iss_other", workspaceId: "proj-2" }), 1),
    ])

    await pullCollabIssues(
      clientReturning([issue({ id: "iss_1", workspaceId: "proj-1" })]),
      { orgId: ORG, workspaceId: "proj-1" },
      { now: () => 2 }
    )

    const rows = await listCollabIssues({ orgId: ORG })
    expect(rows.map((row) => row.id).sort()).toEqual(["iss_1", "iss_other"])
  })

  it("refuses rows the server filed under another org", async () => {
    const result = await pullCollabIssues(
      clientReturning([issue({ id: "iss_1" }), issue({ id: "iss_alien", orgId: "org_other" })]),
      { orgId: ORG },
      { now: () => 1 }
    )
    expect(result.count).toBe(1)
    expect((await listCollabIssues({ orgId: ORG })).map((row) => row.id)).toEqual(["iss_1"])
  })

  it("leaves the mirror untouched when the pull fails", async () => {
    // Blanking the board on a dropped connection would look like "your team
    // deleted everything".
    await replaceCollabIssues({ orgId: ORG }, [toMirrorRow(issue({ id: "iss_kept" }), 1)])

    await expect(
      pullCollabIssues(
        clientReturning(() => Promise.reject(new Error("offline"))),
        { orgId: ORG }
      )
    ).rejects.toThrow("offline")

    expect((await listCollabIssues({ orgId: ORG })).map((row) => row.id)).toEqual(["iss_kept"])
  })

  it("an empty answer does empty the scope — that is not a failure", async () => {
    await replaceCollabIssues({ orgId: ORG }, [toMirrorRow(issue({ id: "iss_1" }), 1)])
    const result = await pullCollabIssues(clientReturning([]), { orgId: ORG }, { now: () => 3 })
    expect(result.count).toBe(0)
    expect(await listCollabIssues({ orgId: ORG })).toEqual([])
  })
})
