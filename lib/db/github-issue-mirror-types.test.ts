// Type-only module — no runtime code lives here. The side-effect import keeps
// the (empty) module body in coverage; the literals below document the row
// shape the GitHub mapper produces and the board reads.
import "./github-issue-mirror-types"
import type {
  GithubIssueMirrorLabel,
  GithubIssueMirrorRow,
  GithubIssueState,
  GithubIssueStateReason,
  GithubMirrorCursor,
} from "./github-issue-mirror-types"

function row(overrides: Partial<GithubIssueMirrorRow> = {}): GithubIssueMirrorRow {
  return {
    id: "acme/app#42",
    repoFullName: "acme/app",
    number: 42,
    title: "Crash on launch",
    state: "open",
    assigneeLogins: [],
    labels: [],
    htmlUrl: "https://github.com/acme/app/issues/42",
    commentCount: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    syncedAt: 1_700_000_200_000,
    ...overrides,
  }
}

describe("GithubIssueMirrorRow", () => {
  it("keys a row by `${repoFullName}#${number}`", () => {
    const r = row()
    expect(r.id).toBe(`${r.repoFullName}#${r.number}`)
  })

  it("keeps GitHub's own state vocabulary rather than a pre-mapped one", () => {
    const states: GithubIssueState[] = ["open", "closed"]
    const reasons: GithubIssueStateReason[] = ["completed", "not_planned", "reopened"]
    expect(states).toHaveLength(2)
    expect(reasons).toContain("not_planned")
  })

  it("tolerates an absent state_reason — GitHub returns null for open issues", () => {
    expect(row({ state: "open" }).stateReason).toBeUndefined()
    expect(row({ state: "closed", stateReason: "completed", closedAt: 1 }).stateReason).toBe(
      "completed"
    )
  })

  it("spells 'unassigned' as an empty array, not an absent field", () => {
    expect(row().assigneeLogins).toEqual([])
    expect(row({ assigneeLogins: ["octocat"] }).assigneeLogins).toEqual(["octocat"])
  })

  it("carries the page ETag on the row so a conditional re-fetch needs no second store", () => {
    expect(row({ etag: 'W/"abc"' }).etag).toBe('W/"abc"')
  })

  it("keeps a label colour optional — GitHub ships hex without a leading '#'", () => {
    const label: GithubIssueMirrorLabel = { name: "bug", color: "d73a4a" }
    expect(label.color).not.toMatch(/^#/)
    const bare: GithubIssueMirrorLabel = { name: "chore" }
    expect(bare.color).toBeUndefined()
  })

  it("binds a row to a delivery container only when one exists", () => {
    expect(row().issueProjectId).toBeUndefined()
    expect(row({ issueProjectId: "ip_1" }).issueProjectId).toBe("ip_1")
  })
})

describe("GithubMirrorCursor", () => {
  it("requires only the repo — a first-ever sync has no watermark yet", () => {
    const cursor: GithubMirrorCursor = { repoFullName: "acme/app" }
    expect(cursor.since).toBeUndefined()
    expect(cursor.lastError).toBeUndefined()
  })

  it("hands GitHub an ISO-8601 `since`, not the epoch millis the rows use", () => {
    const cursor: GithubMirrorCursor = {
      repoFullName: "acme/app",
      since: "2026-08-20T00:00:00Z",
      etag: 'W/"abc"',
      lastSyncedAt: 1_700_000_000_000,
    }
    expect(cursor.since).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(typeof cursor.lastSyncedAt).toBe("number")
  })
})
