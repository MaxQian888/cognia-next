import type { IntegrationActionHandlerContext } from "@/types/plugin/plugin-integration"
import { runGithubIssueLoop, type GithubIssueLoopDependencies } from "./github-issue-loop"

const context: IntegrationActionHandlerContext = {
  pluginId: "github-delivery",
  integrationId: "github",
  accountId: "account-1",
  jobId: "job-1",
  signal: new AbortController().signal,
  authenticatedRequest: jest.fn(),
}

function dependencies(overrides: Partial<GithubIssueLoopDependencies> = {}) {
  const request = jest
    .fn()
    .mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { title: "Fix the bug", body: null, html_url: "https://github.com/o/r/issues/7" },
    })
    .mockResolvedValueOnce({
      status: 201,
      headers: {},
      data: { number: 11, html_url: "https://github.com/o/r/pull/11" },
    })
  const deps: GithubIssueLoopDependencies = {
    request: request as unknown as GithubIssueLoopDependencies["request"],
    resolveCredential: jest.fn(async () => "installation-token"),
    clone: jest.fn(async () => ({
      backend: "local" as const,
      path: "/tmp/worktree",
      repoFullName: "o/r",
      branch: "cognia/issue-7",
      createdAt: 1,
    })),
    executeAgent: jest.fn(async () => ({ text: "done" })),
    commitAndPush: jest.fn(async () => "deadbeef"),
    remove: jest.fn(async () => true),
    getJob: jest.fn(async () => undefined),
    updateJob: jest.fn(async (_id, patch) => patch),
    ...overrides,
  }
  return deps
}

const input = {
  repoFullName: "o/r",
  issueNumber: 7,
  head: "cognia/issue-7",
  base: "main",
}

describe("runGithubIssueLoop", () => {
  it("runs the guarded issue-to-branch-to-PR path and cleans the workspace", async () => {
    const deps = dependencies()

    await expect(runGithubIssueLoop(input, context, deps)).resolves.toEqual({
      pullRequestNumber: 11,
      pullRequestUrl: "https://github.com/o/r/pull/11",
      branch: "cognia/issue-7",
      commitSha: "deadbeef",
    })

    expect(deps.clone).toHaveBeenCalledWith({
      repoFullName: "o/r",
      branch: "cognia/issue-7",
      baseBranch: "main",
      token: "installation-token",
      backend: "local",
    })
    expect(deps.executeAgent).toHaveBeenCalledWith(
      expect.stringContaining("Fix the bug"),
      expect.objectContaining({ cwd: "/tmp/worktree", toolsEnabled: true })
    )
    expect(deps.remove).toHaveBeenCalledTimes(1)
  })

  it("persists a failure checkpoint and still cleans up", async () => {
    const deps = dependencies({
      executeAgent: jest.fn(async () => Promise.reject(new Error("agent failed"))),
    })

    await expect(runGithubIssueLoop(input, context, deps)).rejects.toThrow("agent failed")
    expect(deps.updateJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ output: expect.objectContaining({ checkpoint: "agent_failed" }) })
    )
    expect(deps.remove).toHaveBeenCalledTimes(1)
  })

  it("resumes after a completed push without rerunning the agent", async () => {
    const deps = dependencies({
      request: jest.fn(async () => ({
        status: 201,
        headers: {},
        data: { number: 11, html_url: "https://github.com/o/r/pull/11" },
      })) as unknown as GithubIssueLoopDependencies["request"],
      getJob: jest.fn(async () => ({
        output: {
          checkpoint: "pushed",
          branch: "cognia/issue-7",
          commitSha: "abc123",
        },
      })),
    })

    const result = await runGithubIssueLoop(input, context, deps)
    expect(result).toMatchObject({ commitSha: "abc123", pullRequestNumber: 11 })
    expect(deps.clone).not.toHaveBeenCalled()
    expect(deps.executeAgent).not.toHaveBeenCalled()
    expect(deps.remove).not.toHaveBeenCalled()
  })

  it("checkpoints a push failure and cleans the isolated workspace", async () => {
    const deps = dependencies({
      commitAndPush: jest.fn(async () => Promise.reject(new Error("push unavailable"))),
    })

    await expect(runGithubIssueLoop(input, context, deps)).rejects.toThrow("push unavailable")
    expect(deps.updateJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({
        output: expect.objectContaining({ checkpoint: "push_failed" }),
      })
    )
    expect(deps.remove).toHaveBeenCalledTimes(1)
  })

  it("checkpoints a pull request conflict and resumes from the pushed commit", async () => {
    const conflictRequest: GithubIssueLoopDependencies["request"] = async <T>() => ({
      status: 422,
      headers: {},
      data: {} as T,
    })
    const deps = dependencies({
      request: conflictRequest,
      getJob: jest.fn(async () => ({
        output: {
          checkpoint: "pull_request_failed",
          branch: "cognia/issue-7",
          commitSha: "abc123",
        },
      })),
    })

    await expect(runGithubIssueLoop(input, context, deps)).rejects.toThrow(
      "GitHub pull request creation failed with status 422"
    )
    expect(deps.clone).not.toHaveBeenCalled()
    expect(deps.executeAgent).not.toHaveBeenCalled()
    expect(deps.updateJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({
        output: expect.objectContaining({
          checkpoint: "pull_request_failed",
          commitSha: "abc123",
        }),
      })
    )
  })

  it("persists cancellation as an agent failure and cleans the workspace", async () => {
    const deps = dependencies({
      executeAgent: jest.fn(async () =>
        Promise.reject(new DOMException("Cancelled", "AbortError"))
      ),
    })

    await expect(runGithubIssueLoop(input, context, deps)).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(deps.updateJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({
        output: expect.objectContaining({
          checkpoint: "agent_failed",
          error: expect.stringContaining("Cancelled"),
        }),
      })
    )
    expect(deps.remove).toHaveBeenCalledTimes(1)
  })
})
