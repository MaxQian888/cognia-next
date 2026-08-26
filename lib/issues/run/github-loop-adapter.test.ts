/**
 * @jest-environment jsdom
 */

import type { Issue, IssueProject, IssueRun } from "@/types/issues"
import type { IntegrationAccount, IntegrationActionJob } from "@/types/plugin/plugin-integration"
import {
  DEFAULT_GITHUB_LOOP_BASE,
  GITHUB_LOOP_BASE_OPTION,
  GITHUB_LOOP_RUN_ADAPTER_ID,
  GITHUB_LOOP_STACK_ON_OPTION,
  boundRepoFor,
  issueProjectLocalRoot,
  stackCandidatesFrom,
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
  const parents: Array<[string, string, string]> = []
  const workspace = { roots: [{ id: "root-1", path: "/checkout" }] }
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
    recordParent: async (repoPath, branch, parent) => {
      parents.push([repoPath, branch, parent])
    },
    loadWorkspace: async () => workspace,
    ...over,
  }
  return { deps, executed, approved, cancelled, runs, parents }
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

describe("stackCandidatesFrom", () => {
  function loopRun(over: Partial<IssueRun>): IssueRun {
    return run({
      kind: "github-loop",
      status: "succeeded",
      targetRef: { repoFullName: "octo/repo", head: "issue/merc-1", base: "main" },
      ...over,
    })
  }

  it("offers only branches a succeeded run actually pushed", () => {
    // The loop pushes on its way to opening the pull request, so a running run
    // may not have pushed and a failed one may never have. Basing a pull
    // request on a branch the remote lacks is rejected by GitHub.
    const candidates = stackCandidatesFrom(
      [
        loopRun({ issueId: "iss-a", targetRef: { repoFullName: "octo/repo", head: "a" } }),
        loopRun({
          issueId: "iss-b",
          status: "running",
          targetRef: { repoFullName: "octo/repo", head: "b" },
        }),
        loopRun({
          issueId: "iss-c",
          status: "failed",
          targetRef: { repoFullName: "octo/repo", head: "c" },
        }),
        loopRun({
          issueId: "iss-d",
          status: "queued",
          targetRef: { repoFullName: "octo/repo", head: "d" },
        }),
      ],
      { issueId: "iss-1", repoFullName: "octo/repo" }
    )
    expect(candidates.map((candidate) => candidate.branch)).toEqual(["a"])
  })

  it("never offers the issue its own branch", () => {
    const candidates = stackCandidatesFrom(
      [loopRun({ issueId: "iss-1", targetRef: { repoFullName: "octo/repo", head: "mine" } })],
      { issueId: "iss-1", repoFullName: "octo/repo" }
    )
    expect(candidates).toEqual([])
  })

  it("keeps to the repository being run against", () => {
    const candidates = stackCandidatesFrom(
      [
        loopRun({ issueId: "iss-a", targetRef: { repoFullName: "other/repo", head: "a" } }),
        loopRun({ issueId: "iss-b", targetRef: { repoFullName: "octo/repo", head: "b" } }),
      ],
      { issueId: "iss-1", repoFullName: "octo/repo" }
    )
    expect(candidates.map((candidate) => candidate.branch)).toEqual(["b"])
  })

  it("ignores runs from other engines and rows with no branch", () => {
    const candidates = stackCandidatesFrom(
      [
        loopRun({ issueId: "iss-a", kind: "agent-task" }),
        loopRun({ issueId: "iss-b", targetRef: { repoFullName: "octo/repo" } }),
      ],
      { issueId: "iss-1", repoFullName: "octo/repo" }
    )
    expect(candidates).toEqual([])
  })

  it("collapses repeated runs of one branch to its newest, newest first", () => {
    const candidates = stackCandidatesFrom(
      [
        loopRun({
          id: "r1",
          issueId: "iss-a",
          endedAt: 10,
          targetRef: { repoFullName: "octo/repo", head: "a" },
        }),
        loopRun({
          id: "r2",
          issueId: "iss-a",
          endedAt: 30,
          targetRef: { repoFullName: "octo/repo", head: "a" },
        }),
        loopRun({
          id: "r3",
          issueId: "iss-b",
          endedAt: 20,
          targetRef: { repoFullName: "octo/repo", head: "b" },
        }),
      ],
      { issueId: "iss-1", repoFullName: "octo/repo" }
    )
    expect(candidates.map((candidate) => [candidate.branch, candidate.at])).toEqual([
      ["a", 30],
      ["b", 20],
    ])
  })
})

describe("issueProjectLocalRoot", () => {
  it("resolves a workspace-root reference against the workspace's own roots", () => {
    const withRoot = project({
      resources: [
        { kind: "github-repo", repoFullName: "octo/repo", addedAt: 1 },
        { kind: "workspace-root", rootId: "root-1", addedAt: 2 },
      ],
    })
    expect(issueProjectLocalRoot(withRoot, { roots: [{ id: "root-1", path: "/checkout" }] })).toBe(
      "/checkout"
    )
  })

  it("is undefined when the container only knows the repository by name", () => {
    expect(
      issueProjectLocalRoot(project(), { roots: [{ id: "root-1", path: "/x" }] })
    ).toBeUndefined()
    expect(issueProjectLocalRoot(undefined, { roots: [] })).toBeUndefined()
  })

  it("is undefined when the referenced root is no longer mounted", () => {
    // The reference outlives the mount; trusting it would hand a path that is
    // not the workspace's to a git write.
    const withRoot = project({
      resources: [{ kind: "workspace-root", rootId: "gone", addedAt: 2 }],
    })
    expect(
      issueProjectLocalRoot(withRoot, { roots: [{ id: "root-1", path: "/x" }] })
    ).toBeUndefined()
  })
})

describe("start — stacked mode", () => {
  it("uses the stack branch as the pull request's base", async () => {
    const { deps, executed, runs } = makeDeps()
    const adapter = createGithubLoopRunAdapter(deps)
    await adapter.start(target(), {
      by: HUMAN,
      options: { [GITHUB_LOOP_STACK_ON_OPTION]: " issue/merc-1 " },
    })
    expect((executed[0][1] as { input: { base: string } }).input.base).toBe("issue/merc-1")
    expect(runs[0].targetRef).toMatchObject({ base: "issue/merc-1", stackedOn: "issue/merc-1" })
  })

  it("the stack wins over an explicit base rather than being ignored", async () => {
    // A pull request has one base. Honouring the other silently would produce
    // a flat pull request the user believes is stacked.
    const { deps, executed } = makeDeps()
    const adapter = createGithubLoopRunAdapter(deps)
    await adapter.start(target(), {
      by: HUMAN,
      options: {
        [GITHUB_LOOP_BASE_OPTION]: "develop",
        [GITHUB_LOOP_STACK_ON_OPTION]: "issue/merc-1",
      },
    })
    expect((executed[0][1] as { input: { base: string } }).input.base).toBe("issue/merc-1")
  })

  it("refuses to stack a branch on itself", async () => {
    const { deps } = makeDeps()
    const adapter = createGithubLoopRunAdapter(deps)
    await expect(
      adapter.start(target(), {
        by: HUMAN,
        options: { [GITHUB_LOOP_STACK_ON_OPTION]: "issue/merc-3" },
      })
    ).rejects.toThrow(/cannot stack issue\/merc-3 on itself/)
  })

  it("records the parent in the checkout the container references", async () => {
    // Otherwise the chain is a stack on GitHub and three unrelated branches in
    // the Stacks panel, because the loop clones into its own workspace.
    const { deps, parents } = makeDeps()
    const adapter = createGithubLoopRunAdapter(deps)
    await adapter.start(
      target({
        project: project({
          resources: [
            { kind: "github-repo", repoFullName: "octo/repo", addedAt: 1 },
            { kind: "workspace-root", rootId: "root-1", addedAt: 2 },
          ],
        }),
      }),
      { by: HUMAN, options: { [GITHUB_LOOP_STACK_ON_OPTION]: "issue/merc-1" } }
    )
    expect(parents).toEqual([["/checkout", "issue/merc-3", "issue/merc-1"]])
  })

  it("does not touch a checkout for an unstacked run", async () => {
    const { deps, parents } = makeDeps()
    const adapter = createGithubLoopRunAdapter(deps)
    await adapter.start(target(), { by: HUMAN })
    expect(parents).toEqual([])
  })

  it("a failed local write does not fail a dispatched run", async () => {
    // The pull request is already open by then; the stack is real whether or
    // not a checkout on this machine learns about it.
    const { deps, runs } = makeDeps({
      recordParent: async () => {
        throw new Error("no git bridge")
      },
    })
    const adapter = createGithubLoopRunAdapter(deps)
    await adapter.start(
      target({
        project: project({
          resources: [
            { kind: "github-repo", repoFullName: "octo/repo", addedAt: 1 },
            { kind: "workspace-root", rootId: "root-1", addedAt: 2 },
          ],
        }),
      }),
      { by: HUMAN, options: { [GITHUB_LOOP_STACK_ON_OPTION]: "issue/merc-1" } }
    )
    expect(runs).toHaveLength(1)
  })
})
