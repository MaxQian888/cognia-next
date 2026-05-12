/**
 * Tests for the 12 action.github.* workflow node executors.
 *
 * We mock the runtime singleton so each test asserts on the Octokit request
 * shape (method, endpoint, params) without touching real GitHub. The audit
 * writer is captured to verify allow / deny semantics.
 */

import type { StepExecutionContext } from "@/types/workflow/visual"
import type {
  GhAction,
  GhAuditEntry,
  GhPolicy,
  PolicyDecision,
} from "@/lib/github/types"
import { DEFAULT_GH_POLICY } from "@/lib/github/types"
import { getExecutor } from "@/lib/workflow/nodes/registry"
import { setGithubRuntime } from "./runtime"

// Import for side-effect: registers all 12 executors with the registry.
import "./nodes"

interface FakeOctokit {
  request: jest.Mock
}

function makeFakeRuntime(opts: {
  decision?: PolicyDecision
  octokitResp?: unknown
  audit?: GhAuditEntry[]
}) {
  const audit = opts.audit ?? []
  const octokit: FakeOctokit = {
    request: jest.fn(async () => opts.octokitResp ?? { data: {} }),
  }
  setGithubRuntime({
    getRepo: async () => null,
    getOctokit: async () => octokit as unknown as import("@octokit/core").Octokit,
    recordAudit: async (row) => {
      audit.push(row)
    },
    checkPolicy: async (action, override) => ({
      decision: opts.decision ?? { allow: true },
      effectivePolicy: { ...DEFAULT_GH_POLICY, ...(override as Partial<GhPolicy>) },
    }),
  })
  return { octokit, audit }
}

function makeStep<TParams>(params: TParams): StepExecutionContext<TParams> {
  return {
    runId: "run_test",
    workflowId: "wf_test",
    stepId: "step_test",
    params,
    upstream: {},
    trigger: { kind: "trigger.manual", payload: {} },
    signal: new AbortController().signal,
    log: jest.fn(),
    resolveSecret: jest.fn(async () => undefined),
  } as unknown as StepExecutionContext<TParams>
}

async function exec(kind: string, params: Record<string, unknown>) {
  const reg = getExecutor(kind as never, 1)
  if (!reg) throw new Error(`no executor registered for ${kind}@1`)
  return reg.execute(makeStep(params))
}

afterEach(() => setGithubRuntime(null))

describe("action.github.openPr", () => {
  it("issues POST /pulls and returns number + htmlUrl", async () => {
    const { octokit, audit } = makeFakeRuntime({
      octokitResp: { data: { number: 42, html_url: "https://github.com/o/r/pull/42" } },
    })
    const result = await exec("action.github.openPr", {
      repoFullName: "o/r",
      head: "feat/x",
      base: "main",
      title: "Cool PR",
    })
    expect(result.output).toEqual({ number: 42, htmlUrl: "https://github.com/o/r/pull/42" })
    expect(octokit.request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/pulls",
      expect.objectContaining({ owner: "o", repo: "r", title: "Cool PR" })
    )
    expect(audit).toHaveLength(1)
    expect(audit[0].decision.allow).toBe(true)
  })

  it("policy deny → output.skipped=true and no Octokit call", async () => {
    const { octokit, audit } = makeFakeRuntime({
      decision: { allow: false, reason: "branch protected" },
    })
    const result = await exec("action.github.openPr", {
      repoFullName: "o/r",
      head: "main",
      base: "main",
      title: "x",
    })
    expect((result.output as { skipped: boolean }).skipped).toBe(true)
    expect(octokit.request).not.toHaveBeenCalled()
    expect(audit[0].decision.allow).toBe(false)
  })

  it("rejects malformed repoFullName", async () => {
    makeFakeRuntime({})
    await expect(
      exec("action.github.openPr", { repoFullName: "not-a-repo", head: "x", base: "m", title: "t" })
    ).rejects.toThrow(/bad repo full name/)
  })
})

describe("action.github.closePr", () => {
  it("PATCHes pull with state=closed", async () => {
    const { octokit } = makeFakeRuntime({
      octokitResp: { data: { number: 1, state: "closed" } },
    })
    const result = await exec("action.github.closePr", { repoFullName: "o/r", prNumber: 1 })
    expect(result.output).toEqual({ number: 1, state: "closed" })
    expect(octokit.request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      expect.objectContaining({ state: "closed", pull_number: 1 })
    )
  })
})

describe("action.github.mergePr", () => {
  it("PUTs merge with the chosen method", async () => {
    const { octokit } = makeFakeRuntime({
      octokitResp: { data: { merged: true, sha: "abc" } },
    })
    const result = await exec("action.github.mergePr", {
      repoFullName: "o/r",
      prNumber: 7,
      mergeMethod: "squash",
    })
    expect(result.output).toEqual({ merged: true, sha: "abc" })
    expect(octokit.request).toHaveBeenCalledWith(
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
      expect.objectContaining({ merge_method: "squash" })
    )
  })

  it("defaults mergeMethod to merge", async () => {
    const { octokit } = makeFakeRuntime({ octokitResp: { data: { merged: true, sha: "x" } } })
    await exec("action.github.mergePr", { repoFullName: "o/r", prNumber: 1 })
    expect(octokit.request).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ merge_method: "merge" })
    )
  })
})

describe("action.github.reviewPr", () => {
  it("POSTs to /pulls/{n}/reviews with event + body", async () => {
    const { octokit } = makeFakeRuntime({
      octokitResp: { data: { id: 100, state: "APPROVED" } },
    })
    const result = await exec("action.github.reviewPr", {
      repoFullName: "o/r",
      prNumber: 5,
      event: "APPROVE",
      body: "LGTM",
    })
    expect(result.output).toEqual({ id: 100, state: "APPROVED" })
    expect(octokit.request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      expect.objectContaining({ event: "APPROVE", body: "LGTM" })
    )
  })
})

describe("action.github.commentPr / commentIssue", () => {
  it("commentPr POSTs to /issues/{n}/comments (per GitHub model)", async () => {
    const { octokit } = makeFakeRuntime({
      octokitResp: { data: { id: 1, html_url: "x" } },
    })
    await exec("action.github.commentPr", { repoFullName: "o/r", prNumber: 3, body: "hi" })
    expect(octokit.request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      expect.objectContaining({ issue_number: 3, body: "hi" })
    )
  })

  it("commentIssue posts a comment using the issue number", async () => {
    const { octokit } = makeFakeRuntime({
      octokitResp: { data: { id: 2, html_url: "y" } },
    })
    await exec("action.github.commentIssue", { repoFullName: "o/r", issueNumber: 9, body: "ok" })
    expect(octokit.request).toHaveBeenCalledWith(
      expect.stringContaining("/comments"),
      expect.objectContaining({ issue_number: 9 })
    )
  })
})

describe("action.github.labelIssue", () => {
  it("adds and removes labels in two distinct calls", async () => {
    const { octokit } = makeFakeRuntime({ octokitResp: { data: {} } })
    const result = await exec("action.github.labelIssue", {
      repoFullName: "o/r",
      issueNumber: 11,
      add: ["bug", "triage"],
      remove: ["wontfix"],
    })
    expect(result.output).toEqual({ added: ["bug", "triage"], removed: ["wontfix"] })
    // 1 POST for add + 1 DELETE for the one remove label.
    expect(octokit.request).toHaveBeenCalledTimes(2)
    expect(octokit.request).toHaveBeenNthCalledWith(
      1,
      "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
      expect.objectContaining({ labels: ["bug", "triage"] })
    )
    expect(octokit.request).toHaveBeenNthCalledWith(
      2,
      "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
      expect.objectContaining({ name: "wontfix" })
    )
  })

  it("works with only add or only remove", async () => {
    const { octokit } = makeFakeRuntime({ octokitResp: { data: {} } })
    await exec("action.github.labelIssue", { repoFullName: "o/r", issueNumber: 1, add: ["x"] })
    expect(octokit.request).toHaveBeenCalledTimes(1)
  })
})

describe("action.github.closeIssue", () => {
  it("PATCHes the issue with state=closed and the chosen reason", async () => {
    const { octokit } = makeFakeRuntime({
      octokitResp: { data: { number: 5, state: "closed" } },
    })
    const result = await exec("action.github.closeIssue", {
      repoFullName: "o/r",
      issueNumber: 5,
      reason: "not_planned",
    })
    expect(result.output).toEqual({ number: 5, state: "closed" })
    expect(octokit.request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
      expect.objectContaining({ state_reason: "not_planned" })
    )
  })
})

describe("action.github.createRelease", () => {
  it("defaults draft=true", async () => {
    const { octokit } = makeFakeRuntime({
      octokitResp: { data: { id: 1, html_url: "u", tag_name: "v1" } },
    })
    await exec("action.github.createRelease", { repoFullName: "o/r", tag: "v1" })
    expect(octokit.request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/releases",
      expect.objectContaining({ draft: true })
    )
  })
})

describe("action.github.generateChangelog", () => {
  it("computes bump + nextVersion + markdown from /compare", async () => {
    makeFakeRuntime({
      octokitResp: {
        data: {
          commits: [
            { sha: "abc1234", commit: { message: "feat: add login" } },
            { sha: "def5678", commit: { message: "fix: handle null" } },
            { sha: "0011223", commit: { message: "chore: noise" } },
          ],
        },
      },
    })
    const result = await exec("action.github.generateChangelog", {
      repoFullName: "o/r",
      since: "v1.0.0",
      currentVersion: "1.0.0",
    })
    const out = result.output as {
      bump: string
      nextVersion: string
      markdown: string
      commitCount: number
    }
    expect(out.bump).toBe("minor")
    expect(out.nextVersion).toBe("1.1.0")
    expect(out.commitCount).toBe(3)
    expect(out.markdown).toMatch(/Features/)
  })

  it("bypasses policy for read-only changelog computation", async () => {
    const { audit } = makeFakeRuntime({
      octokitResp: { data: { commits: [] } },
      decision: { allow: false, reason: "should not be consulted" },
    })
    await exec("action.github.generateChangelog", {
      repoFullName: "o/r",
      since: "v1.0.0",
    })
    // The single audit row is the read-only marker, not a deny.
    expect(audit).toHaveLength(1)
    expect(audit[0].decision.allow).toBe(true)
  })
})

describe("action.github.pushTag", () => {
  it("POSTs to /git/refs with refs/tags prefix", async () => {
    const { octokit } = makeFakeRuntime({ octokitResp: { data: {} } })
    await exec("action.github.pushTag", { repoFullName: "o/r", tag: "v1.2.0", sha: "deadbeef" })
    expect(octokit.request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/git/refs",
      expect.objectContaining({ ref: "refs/tags/v1.2.0", sha: "deadbeef" })
    )
  })
})

describe("action.github.runIssueLoop", () => {
  it("returns status=failed when no driver is registered (clear error)", async () => {
    makeFakeRuntime({})
    const result = await exec("action.github.runIssueLoop", {
      repoFullName: "o/r",
      issueNumber: 1,
    })
    const out = result.output as { status: string; reason?: string }
    expect(out.status).toBe("failed")
    expect(out.reason).toMatch(/no issue-loop AI driver/i)
  })

  it("substitutes {n} in branchTemplate when building the audited action", async () => {
    let captured: GhAction | null = null
    setGithubRuntime({
      getRepo: async () => null,
      getOctokit: async () =>
        ({ request: jest.fn(), auth: jest.fn() } as unknown as import("@octokit/core").Octokit),
      recordAudit: async (row) => {
        captured = row.action
      },
      checkPolicy: async () => ({
        decision: { allow: true },
        effectivePolicy: DEFAULT_GH_POLICY,
      }),
    })
    await exec("action.github.runIssueLoop", {
      repoFullName: "o/r",
      issueNumber: 42,
      branchTemplate: "cognia/x-{n}",
    })
    expect(captured).toMatchObject({ kind: "push", branch: "cognia/x-42" })
  })
})

describe("missing runtime", () => {
  it("throws a clear error when runtime is not initialized", async () => {
    setGithubRuntime(null)
    await expect(
      exec("action.github.openPr", { repoFullName: "o/r", head: "x", base: "m", title: "t" })
    ).rejects.toThrow(/not initialized/)
  })
})
