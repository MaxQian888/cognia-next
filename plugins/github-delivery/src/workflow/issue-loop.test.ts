import { setGithubRuntime } from "./runtime"
import {
  describeIssueLoopAction,
  getIssueLoopDriver,
  runIssueLoop,
  setIssueLoopDriver,
} from "./issue-loop"
import { DEFAULT_GH_POLICY } from "@/lib/github/types"

function fakeOctokit(responses: Record<string, unknown>) {
  return {
    request: jest.fn(async (route: string) => responses[route] ?? { data: {} }),
    auth: jest.fn(async () => ({ token: "ghs_fake" })),
  } as unknown as import("@octokit/core").Octokit
}

function installRuntime(octokit: unknown, opts: { workOrders?: jest.Mock } = {}) {
  setGithubRuntime({
    getRepo: async () => null,
    getOctokit: async () => octokit as import("@octokit/core").Octokit,
    recordAudit: async () => {},
    checkPolicy: async () => ({
      decision: { allow: true },
      effectivePolicy: DEFAULT_GH_POLICY,
    }),
    getWorkOrder: async () => null,
    upsertWorkOrder:
      opts.workOrders ??
      jest.fn(async (p) => ({
        ...p,
        createdAt: 0,
        updatedAt: 0,
      })),
  })
}

beforeEach(() => {
  setGithubRuntime(null)
  setIssueLoopDriver(null)
})

describe("runIssueLoop", () => {
  it("returns failed with a clear reason when no driver is registered", async () => {
    installRuntime(fakeOctokit({}))
    const result = await runIssueLoop({ repoFullName: "o/r", issueNumber: 1 })
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/no issue-loop AI driver/i)
  })

  it("runs the full happy path with injected cloner/pusher and driver", async () => {
    const octokit = fakeOctokit({
      "GET /repos/{owner}/{repo}/issues/{issue_number}": {
        data: { title: "Fix the bug", body: "It broke." },
      },
      "POST /repos/{owner}/{repo}/pulls": {
        data: { number: 99, html_url: "https://github.com/o/r/pull/99" },
      },
      "POST /repos/{owner}/{repo}/issues/{issue_number}/labels": { data: {} },
    })
    installRuntime(octokit)

    const driver = {
      run: jest.fn(async () => ({
        summary: "Wrote one line.",
        durationMs: 100,
        driverId: "codex-main",
      })),
    }
    setIssueLoopDriver(driver)

    const cloneSpy = jest.fn(async () => ({
      backend: "local" as const,
      path: "/tmp/wt",
      repoFullName: "o/r",
      branch: "main",
      createdAt: 0,
    }))
    const pushSpy = jest.fn(async () => "abc1234")

    const result = await runIssueLoop(
      { repoFullName: "o/r", issueNumber: 7, externalAgentId: "codex-main" },
      { cloneToWorkspace: cloneSpy, commitAndPush: pushSpy }
    )

    expect(result.status).toBe("pr_opened")
    expect(result.prNumber).toBe(99)
    expect(result.prUrl).toMatch(/pull\/99/)
    expect(result.branch).toBe("cognia/issue-7")

    // Driver was invoked with the right context.
    expect(driver.run).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: "o/r",
        issueNumber: 7,
        issueTitle: "Fix the bug",
        issueBody: "It broke.",
        workspacePath: "/tmp/wt",
        externalAgentId: "codex-main",
      })
    )

    // Cloner / pusher were both called.
    expect(cloneSpy).toHaveBeenCalled()
    expect(pushSpy).toHaveBeenCalled()

    // PR open + label call.
    expect(
      (octokit.request as unknown as jest.Mock).mock.calls.some((c) =>
        String(c[0]).includes("POST /repos/{owner}/{repo}/pulls")
      )
    ).toBe(true)
    expect(
      (octokit.request as unknown as jest.Mock).mock.calls.some((c) =>
        String(c[0]).includes("labels")
      )
    ).toBe(true)
    const prRequest = (octokit.request as unknown as jest.Mock).mock.calls.find((c) =>
      String(c[0]).includes("POST /repos/{owner}/{repo}/pulls")
    )
    expect(prRequest?.[1]).toMatchObject({
      body: expect.stringContaining("Driver: codex-main."),
    })
  })

  it("returns failed when the driver throws", async () => {
    installRuntime(
      fakeOctokit({
        "GET /repos/{owner}/{repo}/issues/{issue_number}": {
          data: { title: "x", body: "y" },
        },
      })
    )
    setIssueLoopDriver({ run: jest.fn(async () => Promise.reject(new Error("model died"))) })
    const result = await runIssueLoop(
      { repoFullName: "o/r", issueNumber: 1 },
      {
        cloneToWorkspace: async () => ({
          backend: "local" as const,
          path: "/tmp",
          repoFullName: "o/r",
          branch: "main",
          createdAt: 0,
        }),
      }
    )
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/model died/)
  })

  it("returns failed when octokit.auth() does not yield a token", async () => {
    installRuntime({
      request: jest.fn(async () => ({ data: { title: "x", body: "" } })),
      auth: jest.fn(async () => ({})),
    } as unknown as import("@octokit/core").Octokit)
    setIssueLoopDriver({ run: jest.fn() })
    const result = await runIssueLoop({ repoFullName: "o/r", issueNumber: 1 })
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/clone token/)
  })

  it("does not push, open a PR, or label after the driver is aborted", async () => {
    const octokit = fakeOctokit({
      "GET /repos/{owner}/{repo}/issues/{issue_number}": {
        data: { title: "x", body: "y" },
      },
    })
    installRuntime(octokit)
    const abortController = new AbortController()
    setIssueLoopDriver({
      run: jest.fn(async () => {
        abortController.abort("cancelled")
        throw new Error("external agent aborted")
      }),
    })
    const pushSpy = jest.fn(async () => "sha")

    const result = await runIssueLoop(
      { repoFullName: "o/r", issueNumber: 1, externalAgentId: "codex-main" },
      {
        abortController,
        cloneToWorkspace: async () => ({
          backend: "local" as const,
          path: "/tmp/work",
          repoFullName: "o/r",
          branch: "main",
          createdAt: 0,
        }),
        commitAndPush: pushSpy,
      }
    )

    expect(result).toMatchObject({ status: "failed", reason: "external agent aborted" })
    expect(pushSpy).not.toHaveBeenCalled()
    expect(octokit.request).not.toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/pulls",
      expect.anything()
    )
    expect(
      (octokit.request as unknown as jest.Mock).mock.calls.some((call) =>
        String(call[0]).includes("/labels")
      )
    ).toBe(false)
  })

  it("replays a completed checkpoint without executing the Agent again", async () => {
    const octokit = fakeOctokit({
      "GET /repos/{owner}/{repo}/issues/{issue_number}": {
        data: { title: "x", body: "y" },
      },
      "POST /repos/{owner}/{repo}/pulls": {
        data: { number: 8, html_url: "u" },
      },
    })
    installRuntime(octokit)
    const driver = { run: jest.fn() }
    setIssueLoopDriver(driver)
    const checkpointRunner = ((options: {
      run: (ctx: {
        state: {
          phase: "completed"
          summary: string
          durationMs: number
          driverId: string
        }
        progress: () => Promise<void>
      }) => Promise<unknown>
    }) => ({
      promise: options.run({
        state: {
          phase: "completed",
          summary: "checkpoint summary",
          durationMs: 17,
          driverId: "codex-main",
        },
        progress: async () => undefined,
      }),
      abort: jest.fn(),
      onProgress: jest.fn(),
    })) as unknown as typeof import("@/lib/workflow/runtime/long-step-runner").runLongStep
    const pushSpy = jest.fn(async () => "sha")

    const result = await runIssueLoop(
      { repoFullName: "o/r", issueNumber: 1, externalAgentId: "codex-main" },
      {
        runLongStep: checkpointRunner,
        cloneToWorkspace: async () => ({
          backend: "local" as const,
          path: "/tmp/work",
          repoFullName: "o/r",
          branch: "main",
          createdAt: 0,
        }),
        commitAndPush: pushSpy,
      }
    )

    expect(result.status).toBe("pr_opened")
    expect(driver.run).not.toHaveBeenCalled()
    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("checkpoint summary"),
      })
    )
  })
})

describe("runIssueLoop work-order writes", () => {
  it("writes in_progress on entry and pr_opened on success", async () => {
    const upsertSpy = jest.fn(async (p) => ({ ...p, createdAt: 0, updatedAt: 0 }))
    const octokit = fakeOctokit({
      "GET /repos/{owner}/{repo}/issues/{issue_number}": {
        data: { title: "T", body: "B" },
      },
      "POST /repos/{owner}/{repo}/pulls": {
        data: { number: 11, html_url: "u" },
      },
      "POST /repos/{owner}/{repo}/issues/{issue_number}/labels": { data: {} },
    })
    installRuntime(octokit, { workOrders: upsertSpy })
    setIssueLoopDriver({
      run: jest.fn(async () => ({
        summary: "did it",
        durationMs: 1,
        driverId: "claude-code",
      })),
    })
    const result = await runIssueLoop(
      { repoFullName: "o/r", issueNumber: 5 },
      {
        cloneToWorkspace: async () => ({
          backend: "local" as const,
          path: "/tmp",
          repoFullName: "o/r",
          branch: "main",
          createdAt: 0,
        }),
        commitAndPush: async () => "sha",
      }
    )
    expect(result.status).toBe("pr_opened")
    // First write: in_progress; second write: pr_opened.
    expect(upsertSpy).toHaveBeenCalledTimes(2)
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({
      repoFullName: "o/r",
      issueNumber: 5,
      status: "in_progress",
      branch: "cognia/issue-5",
    })
    expect(upsertSpy.mock.calls[1][0]).toMatchObject({
      status: "pr_opened",
      prNumber: 11,
    })
  })

  it("writes failed status with lastError when the driver throws", async () => {
    const upsertSpy = jest.fn(async (p) => ({ ...p, createdAt: 0, updatedAt: 0 }))
    installRuntime(
      fakeOctokit({
        "GET /repos/{owner}/{repo}/issues/{issue_number}": {
          data: { title: "T", body: "B" },
        },
      }),
      { workOrders: upsertSpy }
    )
    setIssueLoopDriver({
      run: jest.fn(async () => Promise.reject(new Error("AI ran out of context"))),
    })
    await runIssueLoop(
      { repoFullName: "o/r", issueNumber: 9 },
      {
        cloneToWorkspace: async () => ({
          backend: "local" as const,
          path: "/tmp",
          repoFullName: "o/r",
          branch: "main",
          createdAt: 0,
        }),
      }
    )
    // First call = in_progress, second = failed.
    expect(upsertSpy.mock.calls[1][0]).toMatchObject({
      status: "failed",
      lastError: expect.stringMatching(/AI ran out of context/),
    })
  })
})

describe("setIssueLoopDriver / getIssueLoopDriver", () => {
  it("round-trips the driver singleton", () => {
    expect(getIssueLoopDriver()).toBeNull()
    const d = { run: jest.fn() }
    setIssueLoopDriver(d)
    expect(getIssueLoopDriver()).toBe(d)
    setIssueLoopDriver(null)
    expect(getIssueLoopDriver()).toBeNull()
  })
})

describe("describeIssueLoopAction", () => {
  it("substitutes {n} in branchTemplate", () => {
    expect(describeIssueLoopAction({ repoFullName: "o/r", issueNumber: 42 })).toEqual({
      kind: "push",
      repo: "o/r",
      branch: "cognia/issue-42",
    })
    expect(
      describeIssueLoopAction({
        repoFullName: "o/r",
        issueNumber: 42,
        branchTemplate: "ai/{n}",
      })
    ).toMatchObject({ branch: "ai/42" })
  })
})
