// Type-only module — no runtime code lives here. The side-effect import keeps
// the (empty) module body in coverage; the literals below document the row
// shape the collaboration pull writes and the board reads.
import "./collab-issue-mirror-types"
import type { CollabIssueMirrorRow } from "./collab-issue-mirror-types"

const ADA = "usr_aaaaaaaaaaaaaaaaaaaaaaaa"

function row(overrides: Partial<CollabIssueMirrorRow> = {}): CollabIssueMirrorRow {
  return {
    id: "iss_0123456789abcdef",
    orgId: "org_acme00000000000000000",
    workspaceId: "proj-1",
    issueProjectId: "cont-1",
    title: "Ship it",
    status: "todo",
    priority: "medium",
    boardOrder: 1,
    createdBy: { kind: "human", id: ADA },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    fetchedAt: 1_700_000_200_000,
    ...overrides,
  }
}

describe("CollabIssueMirrorRow", () => {
  it("keys a row by the server's own issue id, not a derived one", () => {
    // The id is globally unique on the plane, so re-deriving one here would
    // only create a second name for the same row.
    expect(row().id).toMatch(/^iss_/)
  })

  it("requires an author with an id — the ADR-0149 §10 supersession", () => {
    // `createdBy` is not optional and its `id` is not optional, which is what
    // ADR-0132's `IssueActor` could not promise.
    const author = row().createdBy
    expect(author.id).toBe(ADA)
    expect(author.kind).toBe("human")
  })

  it("spells 'unassigned' as an absent field, not a half-built actor", () => {
    // A kind without an id is exactly the shape the plane refuses, so it must
    // be unrepresentable here too.
    expect(row().assignee).toBeUndefined()
    expect(row({ assignee: { kind: "team", id: "team-alpha" } }).assignee?.id).toBe("team-alpha")
  })

  it("carries the org alongside the workspace, so a scoped read needs one row", () => {
    // Both are indexed; a mirror keyed only by workspace could not tell two
    // orgs' identically-named workspaces apart.
    const r = row()
    expect(r.orgId).toMatch(/^org_/)
    expect(r.workspaceId).toBe("proj-1")
  })

  it("keeps the server's board order rather than a local one", () => {
    expect(row({ boardOrder: 7.5 }).boardOrder).toBe(7.5)
  })

  it("records when it was pulled, so a stale board can say so", () => {
    const r = row()
    expect(r.fetchedAt).toBeGreaterThanOrEqual(r.updatedAt)
  })

  it("leaves the body optional — an issue may be a title alone", () => {
    expect(row().body).toBeUndefined()
    expect(row({ body: "details" }).body).toBe("details")
  })
})
