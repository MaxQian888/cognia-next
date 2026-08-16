const mockGetTask = jest.fn()
const mockCreateTask = jest.fn()
const mockDeleteTask = jest.fn()
const mockUpdateTask = jest.fn()

jest.mock("@/lib/scheduler/scheduler-db", () => ({
  schedulerDb: {
    getTask: (...args: unknown[]) => mockGetTask(...args),
    createTask: (...args: unknown[]) => mockCreateTask(...args),
    deleteTask: (...args: unknown[]) => mockDeleteTask(...args),
    updateTask: (...args: unknown[]) => mockUpdateTask(...args),
  },
}))

const mockResolveBindings = jest.fn()
jest.mock("./sync-runner", () => ({
  resolveWorkspaceGithubBindings: (...args: unknown[]) => mockResolveBindings(...args),
}))

import {
  GITHUB_ISSUE_SYNC_INTERVAL_MS,
  GITHUB_ISSUE_SYNC_TASK_ID,
  syncGithubIssueSchedule,
} from "./github-sync-schedule"

const oneBinding = [{ repoFullName: "acme/one", issueProjectId: "p1" }]

beforeEach(() => {
  jest.clearAllMocks()
  mockGetTask.mockResolvedValue(null)
})

it("creates the singleton row once a repo is bound", async () => {
  mockResolveBindings.mockResolvedValue(oneBinding)

  await expect(syncGithubIssueSchedule()).resolves.toEqual({
    action: "created",
    bindingCount: 1,
  })

  const task = mockCreateTask.mock.calls[0][0]
  expect(task.id).toBe(GITHUB_ISSUE_SYNC_TASK_ID)
  expect(task.type).toBe("github-issue-sync")
  expect(task.status).toBe("active")
  expect(task.trigger).toMatchObject({
    type: "interval",
    intervalMs: GITHUB_ISSUE_SYNC_INTERVAL_MS,
  })
})

it("sweeps every workspace — the row carries no projectId", async () => {
  mockResolveBindings.mockResolvedValue(oneBinding)
  await syncGithubIssueSchedule()

  expect(mockResolveBindings).toHaveBeenCalledWith()
  expect(mockCreateTask.mock.calls[0][0].payload).toEqual({})
})

it("jitters the fire time so installs don't hit GitHub in lockstep", async () => {
  mockResolveBindings.mockResolvedValue(oneBinding)
  await syncGithubIssueSchedule()

  expect(mockCreateTask.mock.calls[0][0].trigger.jitterMs).toBeGreaterThan(0)
})

it("does not replay missed windows — the watermark already covers them", async () => {
  mockResolveBindings.mockResolvedValue(oneBinding)
  await syncGithubIssueSchedule()

  expect(mockCreateTask.mock.calls[0][0].config.runMissedOnStartup).toBe(false)
})

it("notifies on failure only — a quiet successful refresh is not news", async () => {
  mockResolveBindings.mockResolvedValue(oneBinding)
  await syncGithubIssueSchedule()

  expect(mockCreateTask.mock.calls[0][0].notification).toEqual({
    onStart: false,
    onComplete: false,
    onError: true,
  })
})

it("keeps an existing row untouched rather than resetting a retuned cadence", async () => {
  mockResolveBindings.mockResolvedValue(oneBinding)
  mockGetTask.mockResolvedValue({ id: GITHUB_ISSUE_SYNC_TASK_ID, runCount: 9 })

  await expect(syncGithubIssueSchedule()).resolves.toEqual({
    action: "kept",
    bindingCount: 1,
  })
  expect(mockCreateTask).not.toHaveBeenCalled()
  expect(mockUpdateTask).not.toHaveBeenCalled()
})

it("deletes the row when the last binding goes away", async () => {
  mockResolveBindings.mockResolvedValue([])
  mockGetTask.mockResolvedValue({ id: GITHUB_ISSUE_SYNC_TASK_ID })

  await expect(syncGithubIssueSchedule()).resolves.toEqual({
    action: "deleted",
    bindingCount: 0,
  })
  expect(mockDeleteTask).toHaveBeenCalledWith(GITHUB_ISSUE_SYNC_TASK_ID)
})

it("creates nothing on an install that never touches GitHub", async () => {
  mockResolveBindings.mockResolvedValue([])

  await expect(syncGithubIssueSchedule()).resolves.toEqual({
    action: "skipped",
    bindingCount: 0,
  })
  expect(mockCreateTask).not.toHaveBeenCalled()
  expect(mockDeleteTask).not.toHaveBeenCalled()
})

it("is idempotent across repeated calls", async () => {
  mockResolveBindings.mockResolvedValue(oneBinding)
  await syncGithubIssueSchedule()
  mockGetTask.mockResolvedValue({ id: GITHUB_ISSUE_SYNC_TASK_ID })
  await syncGithubIssueSchedule()

  expect(mockCreateTask).toHaveBeenCalledTimes(1)
})
