/** @jest-environment node */

const mockRegisterLocalIssueSource = jest.fn()
const mockRegisterGithubIssueSource = jest.fn()
const mockRegisterAgentTaskIssueSource = jest.fn()
const mockRegisterAgentTeamIssueSource = jest.fn()
const mockDisposeRunBridge = jest.fn()
const mockDisposeNotifications = jest.fn()
const mockInstallIssueRunBridge = jest.fn((..._args: unknown[]) => mockDisposeRunBridge)
const mockInstallIssueNotifications = jest.fn((..._args: unknown[]) => mockDisposeNotifications)
const mockSeedBuiltinIssueLabels = jest.fn().mockResolvedValue(undefined)
const mockSyncSchedule = jest.fn().mockResolvedValue({ action: "skipped", bindingCount: 0 })
const mockWarn = jest.fn()

jest.mock("@/lib/issues/sources/local-source", () => ({
  registerLocalIssueSource: (...args: unknown[]) => mockRegisterLocalIssueSource(...args),
}))
jest.mock("@/lib/issues/sources/github-source", () => ({
  registerGithubIssueSource: (...args: unknown[]) => mockRegisterGithubIssueSource(...args),
}))
jest.mock("@/lib/issues/sources/agent-task-source", () => ({
  registerAgentTaskIssueSource: (...args: unknown[]) => mockRegisterAgentTaskIssueSource(...args),
}))
jest.mock("@/lib/issues/sources/agent-team-source", () => ({
  registerAgentTeamIssueSource: (...args: unknown[]) => mockRegisterAgentTeamIssueSource(...args),
}))
jest.mock("@/lib/issues/run/install", () => ({
  installIssueRunBridge: (...args: unknown[]) => mockInstallIssueRunBridge(...args),
}))
jest.mock("@/lib/issues/notify", () => ({
  installIssueNotifications: (...args: unknown[]) => mockInstallIssueNotifications(...args),
}))
jest.mock("@/lib/db/labels", () => ({
  seedBuiltinIssueLabels: (...args: unknown[]) => mockSeedBuiltinIssueLabels(...args),
}))
jest.mock("@/lib/issues/github-sync-schedule", () => ({
  syncGithubIssueSchedule: (...args: unknown[]) => mockSyncSchedule(...args),
}))
jest.mock("@cognia/logging", () => ({
  loggers: { shell: { warn: (...a: unknown[]) => mockWarn(...a) } },
}))

import { bootIssueTracker } from "./boot"

beforeEach(() => {
  jest.clearAllMocks()
})

it("registers every issue source and seeds the label catalogue", async () => {
  await bootIssueTracker()
  expect(mockRegisterLocalIssueSource).toHaveBeenCalledTimes(1)
  expect(mockRegisterGithubIssueSource).toHaveBeenCalledTimes(1)
  expect(mockRegisterAgentTaskIssueSource).toHaveBeenCalledTimes(1)
  expect(mockRegisterAgentTeamIssueSource).toHaveBeenCalledTimes(1)
  expect(mockSeedBuiltinIssueLabels).toHaveBeenCalledTimes(1)
})

it("installs the run bridge with an error sink that never throws out of the bridge", async () => {
  await bootIssueTracker()
  expect(mockInstallIssueRunBridge).toHaveBeenCalledTimes(1)
  const options = mockInstallIssueRunBridge.mock.calls[0][0] as {
    onError: (error: unknown) => void
  }
  options.onError(new Error("bridge boom"))
  expect(mockWarn).toHaveBeenCalledWith(
    "issue-tracker: run bridge error",
    expect.objectContaining({ error: expect.stringContaining("bridge boom") })
  )
})

it("passes the injected translator through to the notification watcher", async () => {
  await bootIssueTracker({ translate: (key) => `T:${key}` })
  const options = mockInstallIssueNotifications.mock.calls[0][0] as {
    translate: (key: string) => string
    onError: (error: unknown) => void
  }
  expect(options.translate("x")).toBe("T:x")
  options.onError(new Error("notify boom"))
  expect(mockWarn).toHaveBeenCalledWith(
    "issue-tracker: notify error",
    expect.objectContaining({ error: expect.stringContaining("notify boom") })
  )
})

it("reconciles the GitHub refresh schedule so a binding survives a restart", async () => {
  await bootIssueTracker()
  expect(mockSyncSchedule).toHaveBeenCalledTimes(1)
})

describe("teardown", () => {
  // The brain stops its runtimes in reverse order on shutdown; a run bridge
  // still subscribed to Dexie afterwards would keep a closed database alive.
  it("disposes both watchers, notifications before the run bridge", async () => {
    const order: string[] = []
    mockDisposeNotifications.mockImplementation(() => order.push("notifications"))
    mockDisposeRunBridge.mockImplementation(() => order.push("run-bridge"))

    const stop = await bootIssueTracker()
    expect(order).toEqual([])

    stop()
    expect(order).toEqual(["notifications", "run-bridge"])
  })

  it("does not dispose anything merely by booting", async () => {
    await bootIssueTracker()
    expect(mockDisposeRunBridge).not.toHaveBeenCalled()
    expect(mockDisposeNotifications).not.toHaveBeenCalled()
  })
})
