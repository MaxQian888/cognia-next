/**
 * @jest-environment jsdom
 */

const mockRegisterLocalIssueSource = jest.fn()
const mockRegisterGithubIssueSource = jest.fn()
const mockRegisterAgentTaskIssueSource = jest.fn()
const mockRegisterAgentTeamIssueSource = jest.fn()
const mockInstallIssueRunBridge = jest.fn((..._args: unknown[]) => () => {})
const mockSeedBuiltinIssueLabels = jest.fn().mockResolvedValue(undefined)

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
const mockInstallIssueNotifications = jest.fn((..._args: unknown[]) => () => {})
const mockInstallIssueNotificationCommands = jest.fn((..._args: unknown[]) => () => {})
jest.mock("@/lib/issues/notify", () => ({
  installIssueNotifications: (...args: unknown[]) => mockInstallIssueNotifications(...args),
  installIssueNotificationCommands: (...args: unknown[]) =>
    mockInstallIssueNotificationCommands(...args),
}))
const mockPush = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
jest.mock("@/lib/db/labels", () => ({
  seedBuiltinIssueLabels: (...args: unknown[]) => mockSeedBuiltinIssueLabels(...args),
}))

const mockSyncSchedule = jest.fn().mockResolvedValue({ action: "skipped", bindingCount: 0 })
jest.mock("@/lib/issues/github-sync-schedule", () => ({
  syncGithubIssueSchedule: (...args: unknown[]) => mockSyncSchedule(...args),
}))

const mockWarn = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: { shell: { warn: (...a: unknown[]) => mockWarn(...a) } },
}))

let unlockedAccountId: string | null = null
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { unlockedAccountId: string | null }) => unknown) =>
    selector({ unlockedAccountId }),
}))

import { render, waitFor } from "@testing-library/react"
import { bootIssueTracker, IssueTrackerInitializer } from "./issue-tracker-initializer"

beforeEach(() => {
  jest.clearAllMocks()
  unlockedAccountId = null
})

describe("bootIssueTracker", () => {
  it("registers every issue source AND seeds the label catalogue", async () => {
    await bootIssueTracker()
    expect(mockRegisterLocalIssueSource).toHaveBeenCalledTimes(1)
    expect(mockRegisterGithubIssueSource).toHaveBeenCalledTimes(1)
    expect(mockRegisterAgentTaskIssueSource).toHaveBeenCalledTimes(1)
    expect(mockRegisterAgentTeamIssueSource).toHaveBeenCalledTimes(1)
    expect(mockSeedBuiltinIssueLabels).toHaveBeenCalledTimes(1)
  })

  it("installs the run bridge (adapters + engine watchers) with an error sink", async () => {
    await bootIssueTracker()
    expect(mockInstallIssueRunBridge).toHaveBeenCalledTimes(1)
    const options = (mockInstallIssueRunBridge.mock.calls as unknown as unknown[][])[0]![0] as {
      onError: (error: unknown) => void
    }
    options.onError(new Error("bridge boom"))
    expect(mockWarn).toHaveBeenCalledWith(
      "issue-tracker: run bridge error",
      expect.objectContaining({ error: expect.stringContaining("bridge boom") })
    )
  })

  it("registers the GitHub source even with no repo bound — it reads the mirror only", async () => {
    await bootIssueTracker()
    expect(mockRegisterGithubIssueSource).toHaveBeenCalled()
  })

  it("installs the notification watcher with the injected translator and an error sink", async () => {
    await bootIssueTracker({ translate: (key) => `T:${key}` })
    expect(mockInstallIssueNotifications).toHaveBeenCalledTimes(1)
    const options = (mockInstallIssueNotifications.mock.calls as unknown as unknown[][])[0]![0] as {
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

  it("reconciles the background refresh, so a binding survives a restart", async () => {
    await bootIssueTracker()
    expect(mockSyncSchedule).toHaveBeenCalledTimes(1)
  })
})

describe("IssueTrackerInitializer", () => {
  it("does nothing until an account is unlocked", () => {
    render(<IssueTrackerInitializer />)
    expect(mockRegisterLocalIssueSource).not.toHaveBeenCalled()
  })

  it("boots once the account unlocks", async () => {
    unlockedAccountId = "acct-1"
    render(<IssueTrackerInitializer />)
    await waitFor(() => expect(mockRegisterLocalIssueSource).toHaveBeenCalledTimes(1))
  })

  it("does not re-boot on a re-render for the same account", async () => {
    unlockedAccountId = "acct-1"
    const { rerender } = render(<IssueTrackerInitializer />)
    await waitFor(() => expect(mockRegisterLocalIssueSource).toHaveBeenCalledTimes(1))
    rerender(<IssueTrackerInitializer />)
    expect(mockRegisterLocalIssueSource).toHaveBeenCalledTimes(1)
  })

  it("renders nothing", () => {
    unlockedAccountId = "acct-1"
    const { container } = render(<IssueTrackerInitializer />)
    expect(container).toBeEmptyDOMElement()
  })

  it("threads the live translator into the watcher and mounts the issue.open command", async () => {
    unlockedAccountId = "acct-1"
    render(<IssueTrackerInitializer />)
    await waitFor(() => expect(mockInstallIssueNotifications).toHaveBeenCalledTimes(1))
    const options = (mockInstallIssueNotifications.mock.calls as unknown as unknown[][])[0]![0] as {
      translate: (key: string, values?: Record<string, unknown>) => string
    }
    expect(options.translate("notify.open")).toBe("notify.open")
    expect(options.translate("notify.assigned.title", { identifier: "MERC-1" })).toBe(
      'notify.assigned.title:{"identifier":"MERC-1"}'
    )
    expect(mockInstallIssueNotificationCommands).toHaveBeenCalledTimes(1)
    const commandDeps = (
      mockInstallIssueNotificationCommands.mock.calls as unknown as unknown[][]
    )[0]![0] as { navigate: (path: string) => void }
    commandDeps.navigate("/issues?id=x")
    expect(mockPush).toHaveBeenCalledWith("/issues?id=x")
  })

  it("never lets a failed seed block boot", async () => {
    unlockedAccountId = "acct-1"
    mockSeedBuiltinIssueLabels.mockRejectedValueOnce(new Error("boom"))
    render(<IssueTrackerInitializer />)
    await waitFor(() => expect(mockWarn).toHaveBeenCalled())
  })
})
