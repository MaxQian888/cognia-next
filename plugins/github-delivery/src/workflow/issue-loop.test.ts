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

function installRuntime(octokit: unknown) {
  setGithubRuntime({
    getRepo: async () => null,
    getOctokit: async () => octokit as import("@octokit/core").Octokit,
    recordAudit: async () => {},
    checkPolicy: async () => ({
      decision: { allow: true },
      effectivePolicy: DEFAULT_GH_POLICY,
    }),
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
      run: jest.fn(async () => ({ summary: "Wrote one line.", durationMs: 100 })),
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
      { repoFullName: "o/r", issueNumber: 7 },
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
      })
    )

    // Cloner / pusher were both called.
    expect(cloneSpy).toHaveBeenCalled()
    expect(pushSpy).toHaveBeenCalled()

    // PR open + label call.
    expect((octokit.request as unknown as jest.Mock).mock.calls.some((c) =>
      String(c[0]).includes("POST /repos/{owner}/{repo}/pulls")
    )).toBe(true)
    expect((octokit.request as unknown as jest.Mock).mock.calls.some((c) =>
      String(c[0]).includes("labels")
    )).toBe(true)
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
      { cloneToWorkspace: async () => ({
        backend: "local" as const,
        path: "/tmp",
        repoFullName: "o/r",
        branch: "main",
        createdAt: 0,
      }) }
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
