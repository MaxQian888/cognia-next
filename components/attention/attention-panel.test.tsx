/** @jest-environment jsdom */
import { render, screen, fireEvent, act } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"

const isTauriMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

jest.mock("@/lib/tauri/fleet", () => ({
  fleetGetSnapshot: () => Promise.resolve({ sessions: [], generatedAt: 0 }),
  fleetPermissionRespond: jest.fn().mockResolvedValue(true),
}))

type Handler = (e: { payload: unknown }) => void
const handlers = new Map<string, Handler>()
jest.mock("@tauri-apps/api/event", () => ({
  listen: (topic: string, handler: Handler) => {
    handlers.set(topic, handler)
    return Promise.resolve(jest.fn(() => handlers.delete(topic)))
  },
}))

const pushMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}))

const setSelectedGuildMock = jest.fn()
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setSelectedGuild: setSelectedGuildMock }),
}))

import { AttentionPanel } from "./attention-panel"
import { resetAttentionForTests } from "@/lib/attention/attention-store"
import { useChatStore } from "@/stores/chat/chat-store"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { fleetStreamStore } from "@/lib/fleet/fleet-stream-store"
import { FLEET_UPDATE_EVENT } from "@/lib/fleet/types"
import type { PendingApproval } from "@/lib/claude/types"

const approval = (requestId: string, over: Partial<PendingApproval> = {}): PendingApproval =>
  ({
    requestId,
    sessionId: "s1",
    toolUseID: "tu",
    toolName: "Bash",
    input: {},
    ...over,
  }) as PendingApproval

const renderPanel = () =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AttentionPanel />
    </NextIntlClientProvider>
  )

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)))

beforeEach(() => {
  jest.clearAllMocks()
  handlers.clear()
  isTauriMock.mockReturnValue(true)
  useChatStore.getState().clear()
  usePendingGatesStore.setState({ gates: [] })
  fleetStreamStore.resetForTests()
  resetAttentionForTests()
})

describe("AttentionPanel", () => {
  it("renders the trigger without a count when nothing is pending", () => {
    renderPanel()
    expect(screen.getByTestId("attention-trigger")).toBeInTheDocument()
    expect(screen.queryByTestId("attention-count")).toBeNull()
  })

  it("shows the live count and an empty state / rows in the sheet", async () => {
    renderPanel()
    await flush()
    act(() => useChatStore.getState().pushApproval(approval("r1")))
    expect(screen.getByTestId("attention-count")).toHaveTextContent("1")
    fireEvent.click(screen.getByTestId("attention-trigger"))
    expect(screen.getByTestId("attention-row-chat:r1")).toBeInTheDocument()
  })

  it("chat row navigates to the owning session", async () => {
    renderPanel()
    await flush()
    act(() => useChatStore.getState().pushApproval(approval("r1")))
    fireEvent.click(screen.getByTestId("attention-trigger"))
    fireEvent.click(screen.getByRole("button", { name: "Open" }))
    expect(useChatStore.getState().activeSessionId).toBe("s1")
    expect(setSelectedGuildMock).toHaveBeenCalledWith({ kind: "dm" })
    expect(pushMock).toHaveBeenCalledWith("/")
  })

  it("team row navigates to the workspace with the teamId param", async () => {
    renderPanel()
    await flush()
    act(() =>
      usePendingGatesStore.getState().open({
        key: { scope: "agent-team-budget", id: "run-1" },
        gateType: "budget",
        title: "Budget",
        runId: "run-1",
        teamId: "team-9",
      })
    )
    fireEvent.click(screen.getByTestId("attention-trigger"))
    fireEvent.click(screen.getByRole("button", { name: "Open" }))
    expect(pushMock).toHaveBeenCalledWith("/agent-teams/workspace?teamId=team-9")
  })

  it("fleet permission row renders inline Approve/Deny actions", async () => {
    renderPanel()
    await flush()
    act(() => {
      handlers.get(FLEET_UPDATE_EVENT)!({
        payload: {
          generatedAt: 9,
          sessions: [
            {
              agent: "claude-code",
              sessionId: "f1",
              status: "waiting-permission",
              pendingPermission: {
                requestId: "p1",
                toolName: "bash",
                detail: null,
                requestedAt: Date.now(),
              },
              projectName: "proj",
              capabilities: { approvePermission: true },
              startedAt: 1,
              lastEventAt: 2,
            },
          ],
        },
      })
    })
    fireEvent.click(screen.getByTestId("attention-trigger"))
    expect(screen.getByTestId("attention-row-fleet:claude-code:f1")).toBeInTheDocument()
    // IslandPermissionActions mounts its Approve/Deny buttons inline.
    expect(screen.getAllByRole("button").length).toBeGreaterThan(1)
  })

  it("stale rows are muted and Dismiss clears them", async () => {
    renderPanel()
    await flush()
    act(() => {
      useChatStore.getState().pushApproval(approval("dead"))
      useChatStore.getState().markApprovalInterrupted("dead", "s1")
    })
    fireEvent.click(screen.getByTestId("attention-trigger"))
    const row = screen.getByTestId("attention-row-chat:dead")
    expect(row.className).toContain("opacity-60")
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(useChatStore.getState().sessions.s1.pendingApprovals).toEqual([])
  })
})
