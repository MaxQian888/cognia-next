import { act, render, waitFor } from "@testing-library/react"

const mockConnect = jest.fn()
const mockDiscover = jest.fn()
const mockSync = jest.fn()
const mockResolve = jest.fn()
const mockClose = jest.fn()
const mockRecover = jest.fn()
jest.mock("@/lib/collab/shared-run-coordinator", () => ({
  recoverSharedSessionRun: (...args: unknown[]) => mockRecover(...args),
  suspendSharedSessionRuns: jest.fn(),
}))
let mockAccount: string | null = "account"
let mockWorkspace: string | null = "workspace"
let mockSession = {
  id: "local",
  collaboration: { orgId: "org", sessionId: "shared", endpoint: "https://collab.test" },
}
let mockOpenSessionIds: string[] = []
let mockPaneIdsBySession: Record<string, string[]> = {}
let mockExtraSessions: Record<string, typeof mockSession> = {}
let mockIdentity: { userId: string; orgId: string; updatedAt: number } | undefined
let mockEnabled = true
let mockConnectionChanged: () => void
const mockUnsubscribe = jest.fn()
jest.mock("@/lib/identity/user-binding", () => ({
  UserBindingRegistry: jest.fn(() => ({ get: () => mockIdentity })),
}))
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: (query: () => unknown) => query() }))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (value: unknown) => unknown) =>
    selector({ unlockedAccountId: mockAccount }),
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (value: unknown) => unknown) =>
    selector({ activeProjectId: mockWorkspace }),
}))
jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (value: unknown) => unknown) =>
    selector({
      activeSessionId: "local",
      openSessionIds: mockOpenSessionIds,
      paneIdsBySession: mockPaneIdsBySession,
    }),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    sessions: {
      get: (id: string) => mockExtraSessions[id] ?? mockSession,
      bulkGet: (ids: string[]) => ids.map((id) => mockExtraSessions[id] ?? mockSession),
    },
  }),
}))
jest.mock("@/lib/collab/connection", () => ({
  subscribeCollabConnection: (listener: () => void) => {
    mockConnectionChanged = listener
    return mockUnsubscribe
  },
}))
jest.mock("@/lib/collab/shared-chat-feature", () => ({
  isSharedChatClientEnabled: () => mockEnabled,
}))
jest.mock("@/hooks/collab/use-shared-chat-enabled", () => ({
  useSharedChatEnabled: () => mockEnabled,
}))
jest.mock("@/lib/collab/runtime-client", () => ({
  resolveCurrentCollabContext: (...args: unknown[]) => mockResolve(...args),
}))
jest.mock("@/lib/collab/shared-chat-sync", () => ({
  connectSharedSessionStream: (...args: unknown[]) => mockConnect(...args),
  listAndCacheSharedSessions: (...args: unknown[]) => mockDiscover(...args),
  syncSharedSession: (...args: unknown[]) => mockSync(...args),
}))
import { SharedChatLifecycleInitializer } from "./shared-chat-lifecycle-initializer"

beforeEach(() => {
  jest.clearAllMocks()
  mockAccount = "account"
  mockWorkspace = "workspace"
  mockEnabled = true
  mockIdentity = undefined
  mockOpenSessionIds = []
  mockPaneIdsBySession = {}
  mockExtraSessions = {}
  mockSession = {
    id: "local",
    collaboration: { orgId: "org", sessionId: "shared", endpoint: "https://collab.test" },
  }
  mockResolve.mockResolvedValue({ orgId: "org", client: { baseUrl: "https://collab.test" } })
  mockDiscover.mockResolvedValue([{ id: "one" }, { id: "two" }])
  mockSync.mockResolvedValue({})
  mockConnect.mockResolvedValue({ close: mockClose })
})

it("discovers and projects workspace sessions without opening settings and owns one stream", async () => {
  const view = render(<SharedChatLifecycleInitializer />)
  await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(2))
  expect(mockConnect).toHaveBeenCalledTimes(1)
  expect(mockRecover).toHaveBeenCalledWith(mockSession)
  expect(mockSync.mock.calls.map((call) => call[2])).toEqual(["one", "two"])
  view.unmount()
  expect(mockClose).toHaveBeenCalledTimes(1)
  expect(mockConnect.mock.calls[0][3].signal.aborted).toBe(true)
  expect(mockUnsubscribe).toHaveBeenCalled()
})

it("restarts on connection changes and aborts the old scope", async () => {
  render(<SharedChatLifecycleInitializer />)
  await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
  act(() => mockConnectionChanged())
  await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(2))
  expect(mockClose).toHaveBeenCalledTimes(1)
  expect(mockDiscover.mock.calls[0][3].signal.aborted).toBe(true)
})

it("does not start collaboration for a locked profile or disabled feature", () => {
  mockAccount = null
  const view = render(<SharedChatLifecycleInitializer />)
  expect(mockResolve).not.toHaveBeenCalled()
  mockAccount = "account"
  mockEnabled = false
  view.rerender(<SharedChatLifecycleInitializer />)
  expect(mockResolve).not.toHaveBeenCalled()
})

it("does not subscribe to another endpoint or organization", async () => {
  mockResolve.mockResolvedValue({ orgId: "other", client: { baseUrl: "https://other.test" } })
  render(<SharedChatLifecycleInitializer />)
  await waitFor(() => expect(mockDiscover).toHaveBeenCalled())
  expect(mockConnect).not.toHaveBeenCalled()
})

it("closes a stream resolving after unmount", async () => {
  let finish!: (value: unknown) => void
  mockConnect.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const view = render(<SharedChatLifecycleInitializer />)
  await waitFor(() => expect(mockConnect).toHaveBeenCalled())
  view.unmount()
  await act(async () => finish({ close: mockClose }))
  expect(mockClose).toHaveBeenCalled()
})

it("recovers discovery on foreground and reports connection failures without breaking local boot", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  mockDiscover.mockRejectedValue(new Error("offline"))
  mockConnect.mockRejectedValue(new Error("offline"))
  render(<SharedChatLifecycleInitializer />)
  await waitFor(() => expect(warn).toHaveBeenCalledTimes(2))
  mockDiscover.mockResolvedValue([])
  mockConnect.mockResolvedValue({ close: mockClose })
  act(() => document.dispatchEvent(new Event("visibilitychange")))
  await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(2))
  warn.mockRestore()
})

it("keeps open tabs and retained panes synchronized without reconnecting unchanged sessions", async () => {
  mockOpenSessionIds = ["local", "tab"]
  mockPaneIdsBySession = { pane: ["pane-a", "pane-b"] }
  mockExtraSessions = {
    tab: { id: "tab", collaboration: { ...mockSession.collaboration, sessionId: "shared-tab" } },
    pane: { id: "pane", collaboration: { ...mockSession.collaboration, sessionId: "shared-pane" } },
  }
  const view = render(<SharedChatLifecycleInitializer />)
  await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(3))
  expect(mockConnect.mock.calls.map((call) => call[2]).sort()).toEqual([
    "shared",
    "shared-pane",
    "shared-tab",
  ])
  mockPaneIdsBySession = {}
  view.rerender(<SharedChatLifecycleInitializer />)
  await waitFor(() => expect(mockClose).toHaveBeenCalledTimes(1))
  expect(mockConnect).toHaveBeenCalledTimes(3)
})

it("closes existing streams immediately when shared chat is disabled", async () => {
  const view = render(<SharedChatLifecycleInitializer />)
  await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
  mockEnabled = false
  view.rerender(<SharedChatLifecycleInitializer />)
  expect(mockClose).toHaveBeenCalledTimes(1)
  expect(mockConnect.mock.calls[0][3].signal.aborted).toBe(true)
})

it("continues discovering other sessions when one session loses access", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  mockSync.mockRejectedValueOnce(new Error("revoked"))
  render(<SharedChatLifecycleInitializer />)
  await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(2))
  expect(mockSync.mock.calls.map((call) => call[2])).toEqual(["one", "two"])
  warn.mockRestore()
})

it("refreshes workspace discovery in the background without overlapping pulls", async () => {
  jest.useFakeTimers()
  let finish!: (sessions: { id: string }[]) => void
  mockDiscover.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const view = render(<SharedChatLifecycleInitializer />)
  try {
    await act(async () => {})
    expect(mockDiscover).toHaveBeenCalledTimes(1)
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000)
    })
    expect(mockDiscover).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish([])
    })
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000)
    })
    expect(mockDiscover).toHaveBeenCalledTimes(2)
    view.unmount()
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000)
    })
    expect(mockDiscover).toHaveBeenCalledTimes(2)
  } finally {
    view.unmount()
    jest.useRealTimers()
  }
})

it("deduplicates shared bindings and fences execution when the bound identity changes", async () => {
  mockOpenSessionIds = ["local", "alias"]
  mockExtraSessions = { alias: { ...mockSession, id: "alias" } }
  mockIdentity = { userId: "person", orgId: "org", updatedAt: 1 }
  const view = render(<SharedChatLifecycleInitializer />)
  await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
  mockIdentity = { userId: "other-person", orgId: "org", updatedAt: 2 }
  view.rerender(<SharedChatLifecycleInitializer />)
  await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(2))
  expect(mockClose).toHaveBeenCalledTimes(1)
  expect(mockConnect.mock.calls[0][3].signal.aborted).toBe(true)
})

it("pauses discovery while hidden and resumes when foregrounded", async () => {
  const visibility = jest.spyOn(document, "visibilityState", "get")
  visibility.mockReturnValue("hidden")
  const view = render(<SharedChatLifecycleInitializer />)
  try {
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
    expect(mockDiscover).not.toHaveBeenCalled()
    act(() => document.dispatchEvent(new Event("visibilitychange")))
    expect(mockDiscover).not.toHaveBeenCalled()
    visibility.mockReturnValue("visible")
    act(() => document.dispatchEvent(new Event("visibilitychange")))
    await waitFor(() => expect(mockDiscover).toHaveBeenCalledTimes(1))
  } finally {
    view.unmount()
    visibility.mockRestore()
  }
})

it("does not start discovery or streams without a resolved collaboration identity", async () => {
  mockResolve.mockResolvedValue(null)
  render(<SharedChatLifecycleInitializer />)
  await act(async () => {})
  expect(mockDiscover).not.toHaveBeenCalled()
  expect(mockConnect).not.toHaveBeenCalled()
})
