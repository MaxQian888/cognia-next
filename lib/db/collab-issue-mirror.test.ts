/**
 * @jest-environment jsdom
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"

import {
  clearCollabIssues,
  getCollabIssue,
  listCollabIssues,
  replaceCollabIssues,
} from "./collab-issue-mirror"
import type { CollabIssueMirrorRow } from "./collab-issue-mirror-types"

const ORG = "org_acme00000000000000000"
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbbb"
const ADA = "usr_aaaaaaaaaaaaaaaaaaaaaaaa"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function row(overrides: Partial<CollabIssueMirrorRow> = {}): CollabIssueMirrorRow {
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
    fetchedAt: 30,
    ...overrides,
  }
}

describe("listCollabIssues", () => {
  beforeEach(async () => {
    await replaceCollabIssues({ orgId: ORG }, [
      row({ id: "iss_a", boardOrder: 2, workspaceId: "proj-1", issueProjectId: "cont-1" }),
      row({ id: "iss_b", boardOrder: 1, workspaceId: "proj-1", issueProjectId: "cont-2" }),
      row({ id: "iss_c", boardOrder: 3, workspaceId: "proj-2", issueProjectId: "cont-1" }),
    ])
    // Another org, on its own workspace. The same-workspace-id collision is
    // covered explicitly below rather than left implicit in this fixture.
    await replaceCollabIssues({ orgId: OTHER_ORG }, [
      row({ id: "iss_alien", orgId: OTHER_ORG, workspaceId: "proj-alien" }),
    ])
  })

  it("orders by board order, then by recency", async () => {
    const rows = await listCollabIssues({ workspaceId: "proj-1" })
    expect(rows.map((r) => r.id)).toEqual(["iss_b", "iss_a"])
  })

  it("never returns another org's rows when an org is named", async () => {
    const rows = await listCollabIssues({ orgId: ORG })
    expect(rows.every((r) => r.orgId === ORG)).toBe(true)
    expect(rows).toHaveLength(3)
  })

  it("combines the org and workspace filters rather than letting one win", async () => {
    // Reading by the workspace index alone would return a same-named workspace
    // belonging to another org.
    await replaceCollabIssues({ orgId: OTHER_ORG }, [
      row({ id: "iss_shadow", orgId: OTHER_ORG, workspaceId: "proj-1" }),
    ])
    const rows = await listCollabIssues({ orgId: ORG, workspaceId: "proj-1" })
    expect(rows.map((r) => r.id).sort()).toEqual(["iss_a", "iss_b"])
  })

  it("narrows to a delivery container", async () => {
    const rows = await listCollabIssues({ workspaceId: "proj-1", issueProjectId: "cont-2" })
    expect(rows.map((r) => r.id)).toEqual(["iss_b"])
  })

  it("returns everything when nothing is asked for", async () => {
    expect(await listCollabIssues()).toHaveLength(4)
  })
})

describe("replaceCollabIssues", () => {
  it("deletes rows the server no longer reports for that scope", async () => {
    await replaceCollabIssues({ orgId: ORG }, [row({ id: "iss_old" })])
    await replaceCollabIssues({ orgId: ORG }, [row({ id: "iss_new" })])
    expect((await listCollabIssues({ orgId: ORG })).map((r) => r.id)).toEqual(["iss_new"])
  })

  it("scopes the delete, so refreshing one workspace spares the others", async () => {
    await replaceCollabIssues({ orgId: ORG }, [
      row({ id: "iss_1", workspaceId: "proj-1" }),
      row({ id: "iss_2", workspaceId: "proj-2" }),
    ])
    await replaceCollabIssues({ orgId: ORG, workspaceId: "proj-1" }, [
      row({ id: "iss_1b", workspaceId: "proj-1" }),
    ])
    expect((await listCollabIssues({ orgId: ORG })).map((r) => r.id).sort()).toEqual([
      "iss_1b",
      "iss_2",
    ])
  })

  it("never reaches into another org's rows", async () => {
    await replaceCollabIssues({ orgId: OTHER_ORG }, [row({ id: "iss_alien", orgId: OTHER_ORG })])
    await replaceCollabIssues({ orgId: ORG }, [])
    expect((await listCollabIssues({ orgId: OTHER_ORG })).map((r) => r.id)).toEqual(["iss_alien"])
  })

  it("updates a row in place rather than duplicating it", async () => {
    await replaceCollabIssues({ orgId: ORG }, [row({ id: "iss_1", title: "before" })])
    await replaceCollabIssues({ orgId: ORG }, [row({ id: "iss_1", title: "after" })])
    const rows = await listCollabIssues({ orgId: ORG })
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe("after")
  })
})

describe("getCollabIssue", () => {
  it("reads one row by its server id", async () => {
    await replaceCollabIssues({ orgId: ORG }, [row({ id: "iss_1" })])
    expect((await getCollabIssue("iss_1"))?.title).toBe("Ship it")
    expect(await getCollabIssue("iss_missing")).toBeUndefined()
  })
})

describe("clearCollabIssues", () => {
  it("forgets one org and leaves the rest", async () => {
    await replaceCollabIssues({ orgId: ORG }, [row({ id: "iss_1" })])
    await replaceCollabIssues({ orgId: OTHER_ORG }, [row({ id: "iss_alien", orgId: OTHER_ORG })])

    await clearCollabIssues(ORG)

    expect(await listCollabIssues({ orgId: ORG })).toEqual([])
    expect(await listCollabIssues({ orgId: OTHER_ORG })).toHaveLength(1)
  })

  it("forgets everything when no org is named", async () => {
    await replaceCollabIssues({ orgId: ORG }, [row({ id: "iss_1" })])
    await clearCollabIssues()
    expect(await listCollabIssues()).toEqual([])
  })
})
