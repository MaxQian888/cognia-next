/**
 * @jest-environment jsdom
 */

import type { Issue, IssueProject, IssueRun } from "@/types/issues"
import type { IntegrationAccount, IntegrationActionJob } from "@/types/plugin/plugin-integration"
import {
  DEFAULT_GITHUB_LOOP_BASE,
  GITHUB_LOOP_BASE_OPTION,
  GITHUB_LOOP_RUN_ADAPTER_ID,
  boundRepoFor,
  createGithubLoopRunAdapter,
  githubLoopArtifacts,
  githubLoopHeadBranch,
  type GithubLoopRunAdapterDeps,
} from "./github-loop-adapter"
import type { IssueRunTarget } from "./types"

const HUMAN = { kind: "human" } as const
const REF = { repoFullName: "octo/repo", number: 12, htmlUrl: "https://gh/octo/repo/issues/12" }

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: "iss-1",
    identifier: "MERC-3",
    number: 3,
    projectId: "w1",
    issueProjectId: "ip-1",
    title: "Loop me",
    description: "body",
    status: "todo",
    statusCategory: "unstarted",
    priority: "none",
    createdBy: HUMAN,
    labelIds: [],
    order: 0,
    githubRef: REF,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function project(over: Partial<IssueProject> = {}): IssueProject {
  return {
    id: "ip-1",
    projectId: "w1",
    key: "MERC",
    name: "Mercury",
    status: "in_progress",
    priority: "none",
    resources: [{ kind: "github-repo", repoFullName: "octo/repo", addedAt: 1 }],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function target(over: Partial<IssueRunTarget> = {}): IssueRunTarget {
  return { issue: issue(), project: project(), ...over }
}

function job(over: Partial<IntegrationActionJob> = {}): IntegrationActionJob {
  return {
    id: "job-1",
    pluginId: "github-delivery",
    integrationId: "github",
    accountId: "acc-1",
    actionId: "runIssueLoop",
    input: {},
    status: "awaiting_approval",
    risk: "write",
    attempts: 0,
    maxAttempts: 3,
    source: "manual",
    createdAt: "t",
    updatedAt: "t",
    ...over,
  }
}

const account = { id: "acc-1", enabled: true } as IntegrationAccount

function run(over: Partial<IssueRun> = {}): IssueRun {
  return {
    id: "run-1",
    issueId: "iss-1",
    projectId: "w1",
    adapterId: GITHUB_LOOP_RUN_ADAPTER_ID,
    kind: "github-loop",
    targetId: "job-1",
    status: "running",
    by: HUMAN,
    startedAt: 1,
    updatedAt: 1,
    artifacts: [],
    ...over,
  }
}

function makeDeps(over: Partial<GithubLoopRunAdapterDeps> = {}) {
  const executed: Array<[string, unknown]> = []
  const approved: string[] = []
  const cancelled: string[] = []
  const runs: Parameters<GithubLoopRunAdapterDeps["createRun"]>[0][] = []
  const deps: GithubLoopRunAdapterDeps = {
    isAvailable: () => true,
    resolveAccount: async () => account,
    execute: async (pluginId, input) => {
      executed.push([pluginId, input])
      return job()
    },
    approve: async (id) => {
      approved.push(id)
      return job({ id, status: "running" })
    },
    cancelJob: async (id) => {
      cancelled.push(id)
    },
    getJob: async () => undefined,
    createRun: async (input) => {
      runs.push(input)
      return run({ id: "run-new", status: input.status ?? "running" })
    },
    now: () => 99,
    ...over,
  }
  return { deps, executed, approved, cancelled, runs }
}

describe("helpers", () => {
  it("derives the head branch, the bound repo and artifacts", () => {
    expect(githubLoopHeadBranch("MERC-3")).toBe("issue/merc-3")
    expect(boundRepoFor(target())).toBe("octo/repo")
    expect(boundRepoFor(target({ issue: issue({ githubRef: undefined }) }))).toBeUndefined()
    expect(boundRepoFor(target({ project: project({ resources: [] }) }))).toBeUndefined()
    expect(boundRepoFor(target({ project: undefined }))).toBeUndefined()
    expect(githubLoopArtifacts(undefined)).toEqual([])
    expect(githubLoopArtifacts("nope")).toEqual([])
    expect(githubLoopArtifacts({ branch: "b" })).toEqual([])
    expect(
      githubLoopArtifacts({ pullRequestUrl: "https://gh/pr/4", pullRequestNumber: 4 })
    ).toEqual([{ label: "Pull request #4", href: "https://gh/pr/4" }])
    expect(githubLoopArtifacts({ pullRequestUrl: "https://gh/pr/x" })).toEqual([
      { label: "Pull request", href: "https://gh/pr/x" },
    ])
  })
})

describe("canRun", () => {
  it("accepts a linked, bound issue on an available desktop with an account", async () => {
    expect(await createGithubLoopRunAdapter(makeDeps().deps).canRun(target())).toEqual({ ok: true })
  })

  it("refuses each precondition with its own reason", async () => {
    const adapter = createGithubLoopRunAdapter(makeDeps().deps)
    expect(await adapter.canRun(target({ issue: issue({ githubRef: undefined }) }))).toEqual({
      ok: false,
      reason: "no-github-ref",
    })
    expect(await adapter.canRun(target({ project: project({ resources: [] }) }))).toEqual({
      ok: false,
      reason: "no-github-repo",
      detail: "octo/repo",
    })
    expect(
      await createGithubLoopRunAdapter(makeDeps({ isAvailable: () => false }).deps).canRun(target())
    ).toEqual({ ok: false, reason: "desktop-only" })
    expect(
      await createGithubLoopRunAdapter(makeDeps({ resolveAccount: async () => null }).deps).canRun(
        target()
      )
    ).toEqual({ ok: false, reason: "no-github-account" })
  })
})

describe("start", () => {
  it("enqueues runIssueLoop with an idempotency key, approves the write, records the run", async () => {
    const harness = makeDeps()
    const adapter = createGithubLoopRunAdapter(harness.deps)
    const result = await adapter.start(target(), {
      by: HUMAN,
      origin: "interactive",
      options: { [GITHUB_LOOP_BASE_OPTION]: " develop " },
    })
    expect(harness.executed).toHaveLength(1)
    expect(harness.executed[0][0]).toBe("github-delivery")
    expect(harness.executed[0][1]).toMatchObject({
      integrationId: "github",
      accountId: "acc-1",
      actionId: "runIssueLoop",
      source: "manual",
      idempotencyKey: "issue-run:iss-1:99",
      input: {
        repoFullName: "octo/repo",
        issueNumber: 12,
        head: "issue/merc-3",
        base: "develop",
        title: "MERC-3: Loop me",
        body: "body",
      },
    })
    expect(harness.approved).toEqual(["job-1"])
    expect(harness.runs[0]).toMatchObject({
      adapterId: GITHUB_LOOP_RUN_ADAPTER_ID,
      kind: "github-loop",
      targetId: "job-1",
      targetRef: { repoFullName: "octo/repo", head: "issue/merc-3", base: "develop" },
      status: "running",
      now: 99,
    })
    expect(result.id).toBe("run-new")
  })

  it("defaults the base branch and keeps a queued job queued", async () => {
    const executed: Array<[string, unknown]> = []
    const harness = makeDeps({
      execute: async (pluginId, input) => {
        executed.push([pluginId, input])
        return job({ status: "queued" })
      },
    })
    const adapter = createGithubLoopRunAdapter(harness.deps)
    await adapter.start(target({ issue: issue({ description: undefined }) }), {
      by: HUMAN,
      origin: "im",
      options: { [GITHUB_LOOP_BASE_OPTION]: 7 },
    })
    expect(harness.approved).toEqual([])
    expect(harness.runs[0]).toMatchObject({
      status: "queued",
      targetRef: expect.objectContaining({ base: DEFAULT_GITHUB_LOOP_BASE }),
    })
    const [, input] = executed[0] as [string, { input: Record<string, unknown> }]
    expect(input.input).not.toHaveProperty("body")
  })

  it("throws for an unrunnable target", async () => {
    const adapter = createGithubLoopRunAdapter(makeDeps().deps)
    await expect(
      adapter.start(target({ issue: issue({ githubRef: undefined }) }), { by: HUMAN, origin: "im" })
    ).rejects.toThrow(/refused: no-github-ref/)
  })
})

describe("poll / cancel", () => {
  it("maps job statuses to settlements", async () => {
    const cases: Array<[IntegrationActionJob["status"], unknown]> = [
      ["queued", null],
      ["awaiting_approval", null],
      ["running", null],
      ["retry_wait", null],
      [
        "succeeded",
        { status: "succeeded", artifacts: [{ label: "Pull request #4", href: "https://gh/pr/4" }] },
      ],
      ["failed", { status: "failed", error: "job failed" }],
      ["deadlettered", { status: "failed", error: "job deadlettered" }],
      ["cancelled", { status: "cancelled" }],
    ]
    for (const [status, expected] of cases) {
      const adapter = createGithubLoopRunAdapter(
        makeDeps({
          getJob: async () =>
            job({ status, output: { pullRequestUrl: "https://gh/pr/4", pullRequestNumber: 4 } }),
        }).deps
      )
      expect(await adapter.poll(run())).toEqual(expected)
    }
    const withError = createGithubLoopRunAdapter(
      makeDeps({ getJob: async () => job({ status: "failed", error: "boom" }) }).deps
    )
    expect(await withError.poll(run())).toEqual({ status: "failed", error: "boom" })
    const gone = createGithubLoopRunAdapter(makeDeps().deps)
    expect(await gone.poll(run())).toEqual({
      status: "failed",
      error: "integration job no longer exists",
    })
  })

  it("cancels the job", async () => {
    const harness = makeDeps()
    await createGithubLoopRunAdapter(harness.deps).cancel!(run())
    expect(harness.cancelled).toEqual(["job-1"])
  })
})
