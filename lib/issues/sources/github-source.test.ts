/**
 * @jest-environment jsdom
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { upsertGithubIssues } from "@/lib/db/github-issue-mirror"
import { createIssueProject } from "@/lib/db/issue-projects"
import type { GithubIssueMirrorRow } from "@/lib/db/github-issue-mirror-types"
import { createIssueSourceRegistry } from "./registry"
import {
  githubIssueSource,
  githubStateToStatus,
  registerGithubIssueSource,
  toUnifiedGithubIssue,
} from "./github-source"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function mirrorRow(over: Partial<GithubIssueMirrorRow> = {}): GithubIssueMirrorRow {
  const number = over.number ?? 7
  const repoFullName = over.repoFullName ?? "o/r"
  return {
    id: `${repoFullName}#${number}`,
    repoFullName,
    number,
    title: "Something broke",
    state: "open",
    assigneeLogins: [],
    labels: [],
    htmlUrl: `https://github.test/${repoFullName}/issues/${number}`,
    commentCount: 0,
    createdAt: 1,
    updatedAt: 2,
    syncedAt: 3,
    ...over,
  }
}

describe("githubStateToStatus", () => {
  it("maps an open issue to todo", () => {
    expect(githubStateToStatus("open")).toBe("todo")
  })

  it("maps a normal closure to done", () => {
    expect(githubStateToStatus("closed")).toBe("done")
    expect(githubStateToStatus("closed", "completed")).toBe("done")
  })

  it("keeps `not_planned` as canceled, so it never inflates progress", () => {
    // A cancelled issue leaves the progress denominator; collapsing it into
    // "done" would make every project look further along than it is.
    expect(githubStateToStatus("closed", "not_planned")).toBe("canceled")
  })
})

describe("toUnifiedGithubIssue", () => {
  it("prints owner/repo#n rather than a local KEY-n identifier", () => {
    // Two numbering schemes on one board makes MERC-7 and #7 ambiguous.
    expect(toUnifiedGithubIssue(mirrorRow()).identifier).toBe("o/r#7")
  })

  it("is read-only apart from commenting", () => {
    expect(toUnifiedGithubIssue(mirrorRow()).capabilities).toEqual({
      canEdit: false,
      canMove: false,
      canAssign: false,
      canRun: false,
      canComment: true,
      canDelete: false,
      canManageLabels: false,
      canMoveProject: false,
    })
  })

  it("deep-links to GitHub, not into the app", () => {
    const unified = toUnifiedGithubIssue(mirrorRow())
    expect(unified.origin.deepLinkHref).toBe("https://github.test/o/r/issues/7")
    expect(unified.origin.sourceLabel).toBe("GitHub")
  })

  it("derives its status category through the shared anchor", () => {
    expect(toUnifiedGithubIssue(mirrorRow({ state: "closed" }))).toMatchObject({
      status: "done",
      statusCategory: "completed",
    })
  })

  it("reports no priority rather than fabricating one GitHub does not have", () => {
    expect(toUnifiedGithubIssue(mirrorRow()).priority).toBe("none")
  })

  it("maps the first assignee and the author to human actors", () => {
    const unified = toUnifiedGithubIssue(
      mirrorRow({ assigneeLogins: ["bob", "carol"], authorLogin: "alice" })
    )
    expect(unified.assignee).toEqual({ kind: "human", id: "bob", label: "bob" })
    expect(unified.createdBy).toEqual({ kind: "human", id: "alice", label: "alice" })
  })

  it("omits the assignee when GitHub has none", () => {
    expect(toUnifiedGithubIssue(mirrorRow())).not.toHaveProperty("assignee")
  })

  it("namespaces label ids so they cannot collide with the local catalogue", () => {
    expect(toUnifiedGithubIssue(mirrorRow({ labels: [{ name: "bug" }] })).labelIds).toEqual([
      "github:bug",
    ])
  })
})

describe("githubIssueSource.list", () => {
  it("returns the rows bound to one delivery container", async () => {
    await upsertGithubIssues([mirrorRow({ issueProjectId: "p1" })])
    const items = await githubIssueSource.list({ projectId: "w1", issueProjectId: "p1" })
    expect(items.map((item) => item.identifier)).toEqual(["o/r#7"])
  })

  it("returns nothing for a container with no bound repo", async () => {
    await upsertGithubIssues([mirrorRow({ issueProjectId: "p1" })])
    expect(await githubIssueSource.list({ projectId: "w1", issueProjectId: "p2" })).toEqual([])
  })

  it("never leaks another workspace's issues into a workspace-wide read", async () => {
    // The mirror is keyed by repo + container, NOT by workspace, so the
    // workspace-wide read has to resolve this workspace's containers first.
    const mine = await createIssueProject({ projectId: "w1", name: "Mine" })
    const theirs = await createIssueProject({ projectId: "w2", name: "Theirs" })
    await upsertGithubIssues([
      mirrorRow({ number: 1, issueProjectId: mine.id }),
      mirrorRow({ number: 2, issueProjectId: theirs.id }),
    ])

    const items = await githubIssueSource.list({ projectId: "w1" })
    expect(items.map((item) => item.identifier)).toEqual(["o/r#1"])
  })

  it("ignores unbound rows, which belong to no board", async () => {
    await createIssueProject({ projectId: "w1", name: "Mine" })
    await upsertGithubIssues([mirrorRow({ number: 3 })])
    expect(await githubIssueSource.list({ projectId: "w1" })).toEqual([])
  })

  it("returns nothing when the workspace has no containers at all", async () => {
    await upsertGithubIssues([mirrorRow({ issueProjectId: "p-elsewhere" })])
    expect(await githubIssueSource.list({ projectId: "w-empty" })).toEqual([])
  })
})

describe("registerGithubIssueSource", () => {
  it("registers under the github kind", () => {
    const registry = createIssueSourceRegistry()
    registerGithubIssueSource(registry)
    expect(registry.getSource("github")).toBe(githubIssueSource)
  })
})
