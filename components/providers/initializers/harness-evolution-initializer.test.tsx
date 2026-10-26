/** @jest-environment jsdom */
import { render, waitFor } from "@testing-library/react"
import type { StoreApi, UseBoundStore } from "zustand"

interface Slice {
  errorDiagnostic: { id: string; code: string } | null
  messages: unknown[]
}
jest.mock("@/stores/chat/chat-store", () => {
  const { create } = jest.requireActual("zustand") as typeof import("zustand")
  return { useChatStore: create(() => ({ sessions: {} })) }
})
let mockHarnessSettings: Record<string, unknown> | undefined
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: { harnessEvolution: mockHarnessSettings } }) },
}))
const mockInstallRules = jest.fn()
const mockDisposeRules = jest.fn()
jest.mock("@/lib/harness/runtime/live-rules", () => ({
  installLiveToolRules: () => {
    mockInstallRules()
    return Promise.resolve(mockDisposeRules)
  },
}))
const mockInstallActions = jest.fn()
const mockRecover = jest.fn()
jest.mock("@/lib/harness/runtime/run-control", () => ({
  installHarnessNotificationActions: () => {
    mockInstallActions()
    return Promise.resolve(() => undefined)
  },
  recoverOrphanedHarnessRuns: () => mockRecover(),
}))
let mockHostOwned = false
jest.mock("@/lib/db/mobile-outbound-queue", () => ({ hostOwnsSessionState: () => mockHostOwned }))
jest.mock("@/lib/runtime/runtime-snapshot-store", () => ({ getRuntimeSnapshot: () => ({}) }))
const mockGetSession = jest.fn()
jest.mock("@/lib/db/sessions", () => ({ getSession: (id: string) => mockGetSession(id) }))
jest.mock("@/hooks/chat/use-effective-cwd", () => ({
  resolveEffectiveCwdForSession: async () => "/repo",
}))
const mockEnqueue = jest.fn()
jest.mock("@/lib/harness/runtime/failure-trigger", () => ({
  enqueueRunForFailure: (...args: unknown[]) => mockEnqueue(...args),
  defaultFailureTriggerDeps: async () => ({ deps: true }),
}))

import { useChatStore } from "@/stores/chat/chat-store"
import {
  HarnessEvolutionInitializer,
  __resetHarnessEvolutionInitializerForTests,
  handleFailedTurn,
  watchFailedTurns,
} from "./harness-evolution-initializer"

const mockChatStore = useChatStore as unknown as UseBoundStore<
  StoreApi<{ sessions: Record<string, Slice> }>
>

const userMessage = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "Summarise the CSV files" }],
}

beforeEach(() => {
  __resetHarnessEvolutionInitializerForTests()
  mockChatStore.setState({ sessions: {} })
  mockHarnessSettings = { enabled: true, startMode: "background" }
  mockHostOwned = false
  mockRecover.mockReset().mockResolvedValue(["run-1"])
  mockInstallRules.mockReset()
  mockDisposeRules.mockReset()
  mockInstallActions.mockReset()
  mockGetSession
    .mockReset()
    .mockResolvedValue({ id: "s1", characterId: "agent-1", projectId: "proj-1" })
  mockEnqueue.mockReset().mockResolvedValue({ kind: "enqueued", runId: "run-2", created: true })
})

describe("HarnessEvolutionInitializer", () => {
  it("installs live rules and approval actions, and recovers orphaned runs, once", async () => {
    const { unmount } = render(
      <>
        <HarnessEvolutionInitializer />
        <HarnessEvolutionInitializer />
      </>
    )
    await waitFor(() => expect(mockRecover).toHaveBeenCalledTimes(1))
    expect(mockInstallRules).toHaveBeenCalledTimes(1)
    expect(mockInstallActions).toHaveBeenCalledTimes(1)
    unmount()
    expect(mockDisposeRules).toHaveBeenCalled()
  })
})

describe("watchFailedTurns", () => {
  it("reports each new harness failure once and ignores failures present at boot", () => {
    mockChatStore.setState({
      sessions: { old: { errorDiagnostic: { id: "d0", code: "budgetExhausted" }, messages: [] } },
    })
    const seen: string[] = []
    const stop = watchFailedTurns((sessionId, d) => seen.push(`${sessionId}:${d.id}`))
    mockChatStore.setState({
      sessions: {
        old: { errorDiagnostic: { id: "d0", code: "budgetExhausted" }, messages: [] },
        s1: { errorDiagnostic: { id: "d1", code: "budgetExhausted" }, messages: [] },
        s2: { errorDiagnostic: { id: "d2", code: "rateLimited" }, messages: [] },
      },
    })
    mockChatStore.setState({ sessions: { ...mockChatStore.getState().sessions } })
    stop()
    mockChatStore.setState({
      sessions: { s3: { errorDiagnostic: { id: "d3", code: "deadlineExceeded" }, messages: [] } },
    })
    expect(seen).toEqual(["s1:d1"])
  })
})

describe("handleFailedTurn", () => {
  it("queues a run with the failed request in background mode", async () => {
    mockChatStore.setState({ sessions: { s1: { errorDiagnostic: null, messages: [userMessage] } } })
    await handleFailedTurn("s1", { id: "d1", code: "budgetExhausted" } as never)
    expect(mockEnqueue).toHaveBeenCalledWith(
      {
        sessionId: "s1",
        characterId: "agent-1",
        projectId: "proj-1",
        workingDirectory: "/repo",
        diagnostic: { id: "d1", code: "budgetExhausted" },
        prompt: "Summarise the CSV files",
        messageId: "u1",
      },
      { deps: true }
    )
  })

  it("does nothing outside background mode, on a host-owned client, or without a request", async () => {
    mockChatStore.setState({ sessions: { s1: { errorDiagnostic: null, messages: [userMessage] } } })
    mockHarnessSettings = { enabled: true, startMode: "failure-triggered" }
    await handleFailedTurn("s1", { id: "d", code: "budgetExhausted" } as never)
    mockHarnessSettings = { enabled: true, startMode: "background" }
    mockHostOwned = true
    await handleFailedTurn("s1", { id: "d", code: "budgetExhausted" } as never)
    mockHostOwned = false
    mockChatStore.setState({ sessions: { s1: { errorDiagnostic: null, messages: [] } } })
    await handleFailedTurn("s1", { id: "d", code: "budgetExhausted" } as never)
    mockGetSession.mockResolvedValue({ id: "s1" })
    await handleFailedTurn("s1", { id: "d", code: "budgetExhausted" } as never)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })
})
