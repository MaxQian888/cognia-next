/**
 * @jest-environment jsdom
 */

import { replaceCollabIssues } from "@/lib/db/collab-issue-mirror"
import type { CollabIssueMirrorRow } from "@/lib/db/collab-issue-mirror-types"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueSourceRegistry } from "./registry"

import {
  collabIssueIdentifier,
  collabIssueSource,
  registerCollabIssueSource,
  toUnifiedCollabIssue,
} from "./collab-source"

const ORG = "org_acme00000000000000000"
const ADA = "usr_aaaaaaaaaaaaaaaaaaaaaaaa"

function row(overrides: Partial<CollabIssueMirrorRow> = {}): CollabIssueMirrorRow {
  return {
    id: "iss_0123456789abcdef",
    orgId: ORG,
    workspaceId: "proj-1",
    issueProjectId: "cont-1",
    title: "Ship it",
    status: "in_progress",
    priority: "high",
    boardOrder: 3,
    createdBy: { kind: "human", id: ADA, label: "Ada" },
    createdAt: 10,
    updatedAt: 20,
    fetchedAt: 30,
    ...overrides,
  }
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("collabIssueIdentifier", () => {
  it("trims a server uuid to something readable and still copy-pasteable", () => {
    expect(collabIssueIdentifier("iss_0123456789abcdef0123456789abcdef")).toBe("#01234567")
  })

  it("tolerates an id without the prefix rather than slicing into it", () => {
    expect(collabIssueIdentifier("abcdefghij")).toBe("#abcdefgh")
  })
})

describe("toUnifiedCollabIssue", () => {
  it("projects a row without inventing a local-looking identifier", () => {
    // Two numbering schemes on one board makes `MERC-7` and `#7`
    // indistinguishable in conversation.
    const item = toUnifiedCollabIssue(row())
    expect(item.unifiedId).toBe("collab:iss_0123456789abcdef")
    expect(item.kind).toBe("collab")
    expect(item.identifier).toBe("#01234567")
    expect(item.identifier).not.toMatch(/^[A-Z]+-\d+$/)
  })

  it("carries the status category through the shared anchor", () => {
    expect(toUnifiedCollabIssue(row({ status: "in_progress" })).statusCategory).toBe("started")
    expect(toUnifiedCollabIssue(row({ status: "canceled" })).statusCategory).toBe("canceled")
  })

  it("keeps the server's board order rather than flattening to recency", () => {
    // Unlike GitHub, this plane HAS a manual order, so discarding it would
    // scramble a board somebody deliberately arranged.
    expect(toUnifiedCollabIssue(row({ boardOrder: 7 })).order).toBe(7)
  })

  it("is read-only in every capability", () => {
    const item = toUnifiedCollabIssue(row())
    expect(item.capabilities).toEqual({
      canEdit: false,
      canMove: false,
      canAssign: false,
      canRun: false,
      canComment: false,
    })
  })

  it("passes both actors through, ids included", () => {
    const item = toUnifiedCollabIssue(row({ assignee: { kind: "team", id: "team-alpha" } }))
    expect(item.createdBy).toEqual({ kind: "human", id: ADA, label: "Ada" })
    expect(item.assignee).toEqual({ kind: "team", id: "team-alpha" })
  })

  it("omits an absent assignee rather than emitting undefined", () => {
    expect("assignee" in toUnifiedCollabIssue(row())).toBe(false)
  })

  it("reports no labels rather than inventing ids that can never match", () => {
    expect(toUnifiedCollabIssue(row()).labelIds).toEqual([])
  })
})

describe("collabIssueSource.list", () => {
  it("scopes to the queried workspace", async () => {
    await replaceCollabIssues({ orgId: ORG }, [
      row({ id: "iss_here", workspaceId: "proj-1" }),
      row({ id: "iss_elsewhere", workspaceId: "proj-2" }),
    ])

    const items = await collabIssueSource.list({ projectId: "proj-1" })
    expect(items.map((item) => item.sourceId)).toEqual(["iss_here"])
  })

  it("narrows to a delivery container when asked", async () => {
    await replaceCollabIssues({ orgId: ORG }, [
      row({ id: "iss_a", issueProjectId: "cont-1" }),
      row({ id: "iss_b", issueProjectId: "cont-2" }),
    ])

    const items = await collabIssueSource.list({ projectId: "proj-1", issueProjectId: "cont-2" })
    expect(items.map((item) => item.sourceId)).toEqual(["iss_b"])
  })

  it("returns nothing when the mirror is empty, without throwing", async () => {
    expect(await collabIssueSource.list({ projectId: "proj-1" })).toEqual([])
  })
})

describe("registerCollabIssueSource", () => {
  it("registers under the collab kind", () => {
    const registry = createIssueSourceRegistry()
    expect(registry.has("collab")).toBe(false)
    registerCollabIssueSource(registry)
    expect(registry.getSource("collab")).toBe(collabIssueSource)
  })
})
