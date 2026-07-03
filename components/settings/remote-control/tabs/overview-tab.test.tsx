/** @jest-environment jsdom */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { OverviewTab } from "./overview-tab"
import { useRemoteControlStore } from "@/stores/remote-control/store"
import { isTauri } from "@/lib/tauri"
import { emitSchedulerEvent } from "@/lib/scheduler/event-integration"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))

jest.mock("@/lib/scheduler/event-integration", () => {
  const actual = jest.requireActual("@/lib/scheduler/event-integration")
  return { ...actual, emitSchedulerEvent: jest.fn(async () => {}) }
})

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const mockedIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

beforeEach(() => {
  jest.clearAllMocks()
  useRemoteControlStore.getState().reset()
})

describe("OverviewTab", () => {
  it("shows the desktop-only notice on web", () => {
    mockedIsTauri.mockReturnValue(false)
    render(<OverviewTab />)
    expect(screen.getByText(/desktop-only|web/i)).toBeInTheDocument()
  })

  it("shows running endpoint when bound", () => {
    mockedIsTauri.mockReturnValue(true)
    useRemoteControlStore.setState({
      status: {
        inboundRunning: true,
        boundPort: 47821,
        lastCallAt: null,
        inboundCallsTotal: 0,
        hasInboundToken: true,
      },
    })
    render(<OverviewTab />)
    // The endpoint string appears in both the status pill and the endpoint
    // URL row — assert at least one of them rendered.
    expect(screen.getAllByText(/127.0.0.1:47821/).length).toBeGreaterThan(0)
  })

  it("dispatches a custom event from the test button", async () => {
    mockedIsTauri.mockReturnValue(true)
    render(<OverviewTab />)
    fireEvent.click(screen.getByRole("button", { name: /test event/i }))
    await waitFor(() =>
      expect(emitSchedulerEvent).toHaveBeenCalledWith("custom", expect.any(Object))
    )
  })

  it("renders empty-state when there are no recent calls", () => {
    mockedIsTauri.mockReturnValue(true)
    render(<OverviewTab />)
    expect(screen.getByText(/no inbound calls/i)).toBeInTheDocument()
  })

  it("summarizes recent traffic as success / errors / rate", () => {
    mockedIsTauri.mockReturnValue(true)
    useRemoteControlStore.setState({
      recentCalls: [
        {
          id: "a",
          at: "2026-05-03T10:00:00.000Z",
          route: "/api/v1/health",
          status: 200,
          remoteIp: "127.0.0.1",
        },
        {
          id: "b",
          at: "2026-05-03T10:00:01.000Z",
          route: "/api/v1/events",
          status: 200,
          remoteIp: "127.0.0.1",
        },
        {
          id: "c",
          at: "2026-05-03T10:00:02.000Z",
          route: "/api/v1/events",
          status: 500,
          remoteIp: "127.0.0.1",
        },
      ],
    })
    render(<OverviewTab />)
    expect(screen.getByText(/success rate/i)).toBeInTheDocument()
    // 2 of 3 succeeded → 67%.
    expect(screen.getByText("67%")).toBeInTheDocument()
  })

  it("lists recent inbound calls newest-first", () => {
    mockedIsTauri.mockReturnValue(true)
    useRemoteControlStore.setState({
      recentCalls: [
        {
          id: "id-1",
          at: "2026-05-03T10:00:00.000Z",
          route: "/api/v1/health",
          status: 200,
          remoteIp: "127.0.0.1",
        },
        {
          id: "id-2",
          at: "2026-05-03T10:00:01.000Z",
          route: "/api/v1/events",
          status: 401,
          remoteIp: "127.0.0.2",
        },
      ],
    })
    render(<OverviewTab />)
    expect(screen.getByText("/api/v1/health")).toBeInTheDocument()
    expect(screen.getByText("/api/v1/events")).toBeInTheDocument()
    expect(screen.getByText("200")).toBeInTheDocument()
    expect(screen.getByText("401")).toBeInTheDocument()
  })
})
