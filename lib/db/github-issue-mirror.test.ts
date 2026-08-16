/**
 * @jest-environment jsdom
 */

import { createDbTestFixture } from "./test-fixture"
import type { GithubIssueMirrorRow } from "./github-issue-mirror-types"
import {
  bindRepoToIssueProject,
  clearRepoMirror,
  countMirroredIssues,
  getGithubIssue,
  githubMirrorId,
  parseGithubMirrorId,
  latestMirroredUpdate,
  listGithubIssues,
  repoMirrorEtag,
  upsertGithubIssues,
} from "./github-issue-mirror"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function row(over: Partial<GithubIssueMirrorRow> = {}): GithubIssueMirrorRow {
  const repoFullName = over.repoFullName ?? "o/r"
  const number = over.number ?? 1
  return {
    id: githubMirrorId(repoFullName, number),
    repoFullName,
    number,
    title: `Issue ${number}`,
    state: "open",
    assigneeLogins: [],
    labels: [],
    htmlUrl: `https://github.test/${repoFullName}/issues/${number}`,
    commentCount: 0,
    createdAt: 1,
    updatedAt: number,
    syncedAt: number,
    ...over,
  }
}

describe("githubMirrorId", () => {
  it("is stable and human-legible", () => {
    expect(githubMirrorId("o/r", 7)).toBe("o/r#7")
  })
})

describe("parseGithubMirrorId", () => {
  it("round-trips every id githubMirrorId can produce", () => {
    expect(parseGithubMirrorId(githubMirrorId("o/r", 7))).toEqual({
      repoFullName: "o/r",
      number: 7,
    })
  })

  it("survives a repo name containing a dot or dash", () => {
    expect(parseGithubMirrorId("my-org/repo.js#123")).toEqual({
      repoFullName: "my-org/repo.js",
      number: 123,
    })
  })

  it.each(["garbage", "#7", "o/r#", "o/r#abc", "o/r#0", "o/r#-3", "o/r#1.5"])(
    "refuses %s rather than addressing the wrong issue",
    (id) => {
      expect(parseGithubMirrorId(id)).toBeNull()
    }
  )
})

describe("upsertGithubIssues", () => {
  it("writes nothing for an empty page", async () => {
    await upsertGithubIssues([])
    expect(await countMirroredIssues("o/r")).toBe(0)
  })

  it("stores a page and reads it back by number", async () => {
    await upsertGithubIssues([row({ number: 7 })])
    expect(await getGithubIssue("o/r", 7)).toMatchObject({ number: 7, state: "open" })
  })

  it("lets the remote row win wholesale on re-fetch", async () => {
    // There is no local edit to preserve — that is the point of a read-only
    // mirror, so a second fetch replaces rather than merges.
    await upsertGithubIssues([row({ number: 7, title: "old", state: "open" })])
    await upsertGithubIssues([row({ number: 7, title: "new", state: "closed" })])
    expect(await getGithubIssue("o/r", 7)).toMatchObject({ title: "new", state: "closed" })
    expect(await countMirroredIssues("o/r")).toBe(1)
  })

  it("returns undefined for an unknown issue", async () => {
    expect(await getGithubIssue("o/r", 999)).toBeUndefined()
  })
})

describe("listGithubIssues", () => {
  beforeEach(async () => {
    await upsertGithubIssues([
      row({ number: 1, issueProjectId: "p1" }),
      row({ number: 2, issueProjectId: "p1", state: "closed" }),
      row({ number: 3, repoFullName: "o/other", issueProjectId: "p2" }),
    ])
  })

  it("scopes to one repo", async () => {
    expect((await listGithubIssues({ repoFullName: "o/r" })).map((r) => r.number)).toEqual([2, 1])
  })

  it("scopes to one delivery container", async () => {
    expect((await listGithubIssues({ issueProjectId: "p2" })).map((r) => r.number)).toEqual([3])
  })

  it("can drop closed issues", async () => {
    expect(
      (await listGithubIssues({ repoFullName: "o/r", openOnly: true })).map((r) => r.number)
    ).toEqual([1])
  })

  it("intersects repo and container filters rather than unioning them", async () => {
    expect(await listGithubIssues({ repoFullName: "o/r", issueProjectId: "p2" })).toEqual([])
  })

  it("orders most-recently-updated first", async () => {
    expect((await listGithubIssues({})).map((r) => r.number)).toEqual([3, 2, 1])
  })
})

describe("bindRepoToIssueProject", () => {
  it("binds every mirrored row for a repo", async () => {
    await upsertGithubIssues([row({ number: 1 }), row({ number: 2 })])
    await bindRepoToIssueProject("o/r", "p1")
    expect((await listGithubIssues({ issueProjectId: "p1" })).map((r) => r.number)).toEqual([2, 1])
  })

  it("unbinds without deleting the cache", async () => {
    await upsertGithubIssues([row({ number: 1, issueProjectId: "p1" })])
    await bindRepoToIssueProject("o/r", null)
    expect(await listGithubIssues({ issueProjectId: "p1" })).toEqual([])
    expect(await countMirroredIssues("o/r")).toBe(1)
  })

  it("leaves another repo's rows alone", async () => {
    await upsertGithubIssues([
      row({ number: 1 }),
      row({ number: 2, repoFullName: "o/other", issueProjectId: "p9" }),
    ])
    await bindRepoToIssueProject("o/r", "p1")
    expect((await getGithubIssue("o/other", 2))?.issueProjectId).toBe("p9")
  })
})

describe("clearRepoMirror", () => {
  it("drops one repo's cache and keeps the rest", async () => {
    await upsertGithubIssues([row({ number: 1 }), row({ number: 2, repoFullName: "o/other" })])
    await clearRepoMirror("o/r")
    expect(await countMirroredIssues("o/r")).toBe(0)
    expect(await countMirroredIssues("o/other")).toBe(1)
  })
})

describe("watermarks", () => {
  it("reports the newest updatedAt for the next `since`", async () => {
    await upsertGithubIssues([row({ number: 1, updatedAt: 10 }), row({ number: 2, updatedAt: 50 })])
    expect(await latestMirroredUpdate("o/r")).toBe(50)
  })

  it("is undefined for a repo that was never synced", async () => {
    expect(await latestMirroredUpdate("o/never")).toBeUndefined()
  })

  it("returns the most recently written page's ETag", async () => {
    await upsertGithubIssues([row({ number: 1, syncedAt: 10, etag: 'W/"old"' })])
    await upsertGithubIssues([row({ number: 2, syncedAt: 99, etag: 'W/"new"' })])
    expect(await repoMirrorEtag("o/r")).toBe('W/"new"')
  })

  it("has no ETag before the first sync", async () => {
    expect(await repoMirrorEtag("o/never")).toBeUndefined()
  })
})
