const mockRun = jest.fn()
jest.mock("@/lib/issues/sync-runner", () => ({
  runWorkspaceGithubSync: (...args: unknown[]) => mockRun(...args),
  isMissingGithubCredential: (error: unknown) =>
    error instanceof Error && error.name === "MissingGithubCredentialError",
}))

jest.mock("@cognia/logging", () => ({
  loggers: { scheduler: { info: jest.fn(), error: jest.fn() } },
}))

import { executeGithubIssueSyncTask } from "./github-issue-sync-executor"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

const task = (payload?: Record<string, unknown>) =>
  ({ id: "task-1", type: "github-issue-sync", payload }) as unknown as ScheduledTask
const execution = { id: "exec-1" } as unknown as TaskExecution
const signal = new AbortController().signal

const repoResult = (over: Partial<Record<string, unknown>> = {}) => ({
  repoFullName: "acme/one",
  written: 3,
  notModified: false,
  truncated: false,
  ...over,
})

beforeEach(() => jest.clearAllMocks())

it("succeeds with nothing bound — an unbound install is not a failure", async () => {
  mockRun.mockResolvedValue({ repoCount: 0, results: [], failures: [] })

  const result = await executeGithubIssueSyncTask(task(), execution, signal)

  expect(result.success).toBe(true)
  expect(result.output).toMatchObject({ repoCount: 0, written: 0 })
  expect(result.error).toBeUndefined()
})

it("sweeps every workspace when the payload names none", async () => {
  mockRun.mockResolvedValue({ repoCount: 0, results: [], failures: [] })

  await executeGithubIssueSyncTask(task(), execution, signal)

  expect(mockRun).toHaveBeenCalledWith({})
})

it("scopes to one workspace when the payload names it", async () => {
  mockRun.mockResolvedValue({ repoCount: 0, results: [], failures: [] })

  await executeGithubIssueSyncTask(task({ projectId: "ws-1", full: true }), execution, signal)

  expect(mockRun).toHaveBeenCalledWith({ projectId: "ws-1", full: true })
})

it("ignores payload fields of the wrong type rather than forwarding junk", async () => {
  mockRun.mockResolvedValue({ repoCount: 0, results: [], failures: [] })

  await executeGithubIssueSyncTask(
    task({ projectId: 42, full: "yes", unrelated: "x" }),
    execution,
    signal
  )

  expect(mockRun).toHaveBeenCalledWith({})
})

it("totals writes and 304s across repos", async () => {
  mockRun.mockResolvedValue({
    repoCount: 3,
    results: [
      repoResult(),
      repoResult({ repoFullName: "acme/two", written: 0, notModified: true }),
      repoResult({ repoFullName: "acme/three", written: 2, truncated: true }),
    ],
    failures: [],
  })

  const result = await executeGithubIssueSyncTask(task(), execution, signal)

  expect(result.success).toBe(true)
  expect(result.output).toMatchObject({
    repoCount: 3,
    written: 5,
    notModified: 1,
    truncated: 1,
    unauthorized: 0,
  })
})

it("fails the execution when a repo failed, and names it", async () => {
  mockRun.mockResolvedValue({
    repoCount: 2,
    results: [repoResult()],
    failures: [{ repoFullName: "acme/two", error: new Error("boom") }],
  })

  const result = await executeGithubIssueSyncTask(task(), execution, signal)

  // Otherwise a revoked token reads as a healthy cadence forever.
  expect(result.success).toBe(false)
  expect(result.error).toContain("acme/two")
  // The repo that DID sync still reports its writes — failures are isolated.
  expect(result.output).toMatchObject({ written: 3, failedRepos: ["acme/two"] })
})

it("counts a missing credential separately from an ordinary failure", async () => {
  const credentialError = new Error("no token")
  credentialError.name = "MissingGithubCredentialError"
  mockRun.mockResolvedValue({
    repoCount: 2,
    results: [],
    failures: [
      { repoFullName: "acme/one", error: credentialError },
      { repoFullName: "acme/two", error: new Error("network") },
    ],
  })

  const result = await executeGithubIssueSyncTask(task(), execution, signal)

  expect(result.output).toMatchObject({ unauthorized: 1 })
  expect(result.success).toBe(false)
})

it("turns a thrown run into a failed execution rather than a rejected promise", async () => {
  mockRun.mockRejectedValue(new Error("dexie exploded"))

  const result = await executeGithubIssueSyncTask(task(), execution, signal)

  expect(result).toEqual({ success: false, error: "dexie exploded" })
})

it("stringifies a non-Error throw", async () => {
  mockRun.mockRejectedValue("plain string")

  const result = await executeGithubIssueSyncTask(task(), execution, signal)

  expect(result).toEqual({ success: false, error: "plain string" })
})
