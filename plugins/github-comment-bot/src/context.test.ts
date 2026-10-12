import { AUTHOR, fixture, HEAD, issueComment, NOW } from "./comment-bot.test-helpers"
import type { CommandSourceV1 } from "./command-source"
import { CONTEXT_LIMITS, collectContext, inDiff, indexPatch, readThreadItem } from "./context"
import { readerFor } from "./identity"

function source(over: Partial<CommandSourceV1> = {}): CommandSourceV1 {
  return {
    schemaVersion: 1,
    ingress: "webhook",
    repositoryId: "4242",
    repository: "acme/widgets",
    threadKind: "issue",
    threadNumber: 7,
    sourceKind: "issue_comment",
    sourceId: "11",
    sourceRevision: "r",
    sourceCreatedAt: "c",
    sourceBodyHash: "h",
    actor: AUTHOR,
    verb: "ask",
    request: "why \u001b[31mred\u001b[0m?",
    aliased: false,
    ...over,
  }
}

it("collects an issue's command, body and discussion, sanitized, and checks out the default branch", async () => {
  const f = fixture()
  f.github.comments.set(11, issueComment(11, "@cognia-bot ask why"))
  f.github.comments.set(12, issueComment(12, "Earlier \u001b]0;title\u0007note"))
  f.github.comments.set(13, issueComment(13, "Bot said\n\n<!-- cognia-command:v1:a-1 -->"))
  const collected = await collectContext(readerFor(f.context, f.run, f.config), source(), f.now)
  const ids = collected.selection.items.map((item) => item.id)
  expect(ids).toEqual(["command", "parent", "comment-12"])
  expect(collected.selection.items[0].text).toBe("ask: why red?")
  expect(collected.selection.items[2].text).toBe("octo-cat: Earlier note")
  expect(collected.checkout).toEqual({
    ref: "c".repeat(40),
    sha: "c".repeat(40),
    targetRef: "main",
  })
  expect(collected.complete).toBe(true)
  expect(collected.item).toMatchObject({ number: 7, isPullRequest: false, fork: false })
})

it("collects a pull request's line thread, files, diff and CI, and checks out its exact head", async () => {
  const f = fixture()
  f.github.reviewComments.set(20, {
    id: 20,
    body: "Is this safe?",
    path: "src/validate.ts",
    line: 2,
    diff_hunk: "@@ -1,3 +1,5 @@",
    user: { login: "reviewer" },
  })
  f.github.reviewComments.set(21, {
    id: 21,
    in_reply_to_id: 20,
    body: "@cognia-bot ask",
    user: AUTHOR,
  })
  f.github.checks = [
    { name: "test", status: "completed", conclusion: "failure" },
    { name: "lint", status: "completed", conclusion: "success" },
  ]
  const collected = await collectContext(
    readerFor(f.context, f.run, f.config),
    source({
      threadKind: "pull_request",
      threadNumber: 8,
      sourceKind: "review_comment",
      sourceId: "21",
    }),
    f.now
  )
  const byId = Object.fromEntries(collected.selection.items.map((item) => [item.id, item]))
  expect(byId["thread-20"].text).toContain("File src/validate.ts, line 2")
  expect(byId["thread-20"].text).toContain("reviewer: Is this safe?")
  expect(byId.files.text).toBe("modified src/validate.ts (+2 -0)")
  expect(byId.diff.text).toContain("--- src/validate.ts")
  expect(byId.ci.text).toBe("test: completed / failure")
  expect(collected.checkout).toEqual({ ref: "refs/pull/8/head", sha: HEAD })
  expect(collected.diffIndex["src/validate.ts"]).toEqual({ LEFT: [[1, 3]], RIGHT: [[1, 5]] })
  expect(collected.complete).toBe(true)
})

it("marks a review incomplete when files are missing their patch or the diff is cut", async () => {
  const f = fixture()
  f.github.files.push({ filename: "big.bin", status: "modified" })
  const missing = await collectContext(
    readerFor(f.context, f.run, f.config),
    source({ threadKind: "pull_request", threadNumber: 8 }),
    f.now
  )
  expect(missing.complete).toBe(false)
  const g = fixture()
  g.github.files = [
    { filename: "huge.ts", status: "modified", patch: `@@ -1 +1 @@\n${"+x\n".repeat(80_000)}` },
  ]
  const cut = await collectContext(
    readerFor(g.context, g.run, g.config),
    source({ threadKind: "pull_request", threadNumber: 8 }),
    g.now
  )
  expect(cut.selection.items.find((item) => item.id === "diff")?.truncated).toBe(true)
  expect(cut.complete).toBe(false)
})

it("stays inside its read budget and keeps the newest discussion", async () => {
  const f = fixture()
  for (let id = 100; id < 100 + CONTEXT_LIMITS.comments + 10; id += 1)
    f.github.comments.set(
      id,
      issueComment(id, `comment ${id}`, { created_at: new Date(NOW - id).toISOString() })
    )
  const collected = await collectContext(readerFor(f.context, f.run, f.config), source(), f.now)
  const comments = collected.selection.items.filter((item) => item.kind === "comment")
  expect(comments).toHaveLength(CONTEXT_LIMITS.comments)
  expect(comments[0].text).toContain(`comment ${100 + CONTEXT_LIMITS.comments + 9}`)
  expect(collected.fetchedBytes).toBeLessThanOrEqual(CONTEXT_LIMITS.fetchBytes)
})

it("indexes diff hunks for review comment placement", () => {
  const index = { "a.ts": indexPatch("@@ -10,2 +12,0 @@\n-x\n-y\n@@ -30 +31,3 @@\n a\n+b\n+c") }
  expect(index["a.ts"]).toEqual({
    LEFT: [
      [10, 11],
      [30, 30],
    ],
    RIGHT: [[31, 33]],
  })
  expect(inDiff(index, "a.ts", 32, "RIGHT")).toBe(true)
  expect(inDiff(index, "a.ts", 12, "RIGHT")).toBe(false)
  expect(inDiff(index, "a.ts", 11, "LEFT")).toBe(true)
  expect(inDiff(index, "b.ts", 1, "RIGHT")).toBe(false)
})

it("reads a fork pull request as a fork", async () => {
  const f = fixture()
  const pr = f.github.items.get(8)!
  f.github.items.set(8, {
    ...pr,
    head: { ...(pr.head as object), repo: { full_name: "fork/widgets" } },
  })
  const item = await readThreadItem(readerFor(f.context, f.run, f.config), {
    threadNumber: 8,
    threadKind: "pull_request",
    repository: "acme/widgets",
  })
  expect(item).toMatchObject({ fork: true, headSha: HEAD })
})
