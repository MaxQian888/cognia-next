/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"

import { GatewayRouteTicketsPanel } from "./route-tickets-panel"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
  useFormatter: () => ({
    relativeTime: (date: Date) => `rel:${date.getTime()}`,
    dateTime: (date: Date) => `abs:${date.getTime()}`,
    number: (value: number) => String(value),
  }),
  useNow: () => new Date(0),
}))

const mockList = jest.fn()
const mockRevoke = jest.fn()
jest.mock("@/lib/tauri/gateway", () => ({
  gatewayListRouteTickets: () => mockList(),
  gatewayRevokeRouteTicket: (id: string) => mockRevoke(id),
}))

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

const STORAGE_KEY = "cognia-agent-execution-flags-v1"

const ticket = (over: Record<string, unknown> = {}) => ({
  ticketId: "rt_abc123",
  routePinId: "pin_1",
  executionFingerprint: "fp_1",
  sessionId: "sess_9",
  candidates: [{ deploymentId: "dep_1", modelId: "gpt-4o" }],
  modelBindings: {},
  credentialAffinity: "session-sticky" as const,
  routePolicy: "balanced",
  issuedAtMs: Date.now(),
  expiresAtMs: Date.now() + 60_000,
  ...over,
})

beforeEach(() => {
  window.localStorage.clear()
  mockList.mockReset().mockResolvedValue([])
  mockRevoke.mockReset().mockResolvedValue(true)
})

afterEach(() => {
  window.localStorage.clear()
})

describe("GatewayRouteTicketsPanel", () => {
  it("renders an explicit inert state when the capability is off", async () => {
    // Working Rule 7, third axis. A plain empty list would read as "no tickets
    // right now", which is indistinguishable from the capability being switched
    // off — and nothing mints tickets while it is off, so the list can never be
    // anything BUT empty.
    render(<GatewayRouteTicketsPanel />)

    expect(await screen.findByText("disabledTitle")).toBeInTheDocument()
    expect(screen.getByText("disabledDescription")).toBeInTheDocument()
  })

  it("does not list tickets while the capability is off", async () => {
    render(<GatewayRouteTicketsPanel />)

    await waitFor(() => expect(screen.getByText("disabledTitle")).toBeInTheDocument())
    expect(mockList).not.toHaveBeenCalled()
  })

  it("warns that the switch changes agent routing, not just this page", () => {
    render(<GatewayRouteTicketsPanel />)
    expect(screen.getByText("routingWarning")).toBeInTheDocument()
  })

  it("turns the capability on, persists it, and starts listing", async () => {
    render(<GatewayRouteTicketsPanel />)

    fireEvent.click(screen.getByRole("switch", { name: /enableLabel/ }))

    await waitFor(() => expect(mockList).toHaveBeenCalled())
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject({
      gatewayAgentRouteTickets: true,
    })
  })

  it("hydrates as enabled from a stored override", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ gatewayAgentRouteTickets: true }))
    mockList.mockResolvedValue([ticket()])

    render(<GatewayRouteTicketsPanel />)

    expect(await screen.findByTestId("gateway-tickets")).toBeInTheDocument()
    expect(screen.getByText("rt_abc123")).toBeInTheDocument()
    expect(screen.queryByText("disabledTitle")).not.toBeInTheDocument()
  })

  it("shows a loading state rather than claiming 'none issued' before the first read", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ gatewayAgentRouteTickets: true }))
    let resolveList: (rows: unknown[]) => void = () => {}
    mockList.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve as (rows: unknown[]) => void
      })
    )

    render(<GatewayRouteTicketsPanel />)

    expect(await screen.findByTestId("gateway-tickets-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("gateway-tickets-empty")).not.toBeInTheDocument()

    resolveList([])
    expect(await screen.findByTestId("gateway-tickets-empty")).toBeInTheDocument()
  })

  it("distinguishes 'enabled but none issued' from 'not enabled'", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ gatewayAgentRouteTickets: true }))
    mockList.mockResolvedValue([])

    render(<GatewayRouteTicketsPanel />)

    expect(await screen.findByTestId("gateway-tickets-empty")).toHaveTextContent("noneActive")
    expect(screen.queryByText("disabledTitle")).not.toBeInTheDocument()
  })

  it("re-reads the list on demand", async () => {
    // Tickets expire on their own, so the list goes stale without a refresh.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ gatewayAgentRouteTickets: true }))
    mockList.mockResolvedValueOnce([]).mockResolvedValueOnce([ticket()])

    render(<GatewayRouteTicketsPanel />)
    await screen.findByTestId("gateway-tickets-empty")

    fireEvent.click(screen.getByTestId("gateway-tickets-refresh"))

    expect(await screen.findByText("rt_abc123")).toBeInTheDocument()
  })

  it("revokes a ticket and re-reads the list", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ gatewayAgentRouteTickets: true }))
    mockList.mockResolvedValue([ticket()])

    render(<GatewayRouteTicketsPanel />)
    // Await the row itself, not the container: the container also renders while
    // the first read is still in flight.
    await screen.findByText("rt_abc123")

    fireEvent.click(screen.getByRole("button", { name: "revokeAria:rt_abc123" }))
    // Revoking cuts a live agent session off, so the first click only asks.
    expect(mockRevoke).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole("button", { name: "revokeConfirmAction" }))

    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith("rt_abc123"))
    expect(mockList).toHaveBeenCalledTimes(2)
  })

  it("says a lapsed ticket has expired instead of 'expires … ago'", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ gatewayAgentRouteTickets: true }))
    // `useNow` is pinned to the epoch in this file; -1 is already in the past.
    mockList.mockResolvedValue([ticket({ expiresAtMs: -1 })])

    render(<GatewayRouteTicketsPanel />)

    expect(await screen.findByText("ticketMetaExpired:sess_9,1")).toBeInTheDocument()
  })

  it("can back out of a revoke", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ gatewayAgentRouteTickets: true }))
    mockList.mockResolvedValue([ticket()])

    render(<GatewayRouteTicketsPanel />)
    await screen.findByText("rt_abc123")

    fireEvent.click(screen.getByRole("button", { name: "revokeAria:rt_abc123" }))
    fireEvent.click(await screen.findByRole("button", { name: "cancel" }))

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "revokeConfirmAction" })).not.toBeInTheDocument()
    )
    expect(mockRevoke).not.toHaveBeenCalled()
  })

  it("expands a ticket into what it actually grants", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ gatewayAgentRouteTickets: true }))
    mockList.mockResolvedValue([
      ticket({
        operations: ["chat", "embeddings"],
        budget: { maxTokens: 1000, spentTokens: 250, maxRequestsPerMin: 30 },
        modelBindings: { primary: "gpt-4o", haiku: "gpt-4o-mini" },
        parentSessionId: "sess_parent",
        profileVersion: 7,
      }),
    ])

    render(<GatewayRouteTicketsPanel />)
    await screen.findByText("rt_abc123")
    expect(screen.queryByTestId("gateway-ticket-detail-rt_abc123")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /details/ }))

    const detail = await screen.findByTestId("gateway-ticket-detail-rt_abc123")
    expect(detail).toHaveTextContent("embeddings")
    expect(within(detail).queryByText("models")).not.toBeInTheDocument()
    expect(screen.getByTestId("gateway-ticket-budget-rt_abc123")).toHaveTextContent(
      "budgetTokens:250,1000"
    )
    expect(detail).toHaveTextContent("budgetRate:30")
    expect(detail).toHaveTextContent("dep_1 · gpt-4o")
    expect(detail).toHaveTextContent("haiku → gpt-4o-mini")
    expect(detail).toHaveTextContent("sess_parent")
    expect(detail).toHaveTextContent("7")
  })

  it("shows the legacy default scope and an unmetered budget for older tickets", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ gatewayAgentRouteTickets: true }))
    mockList.mockResolvedValue([ticket()])

    render(<GatewayRouteTicketsPanel />)
    await screen.findByText("rt_abc123")
    fireEvent.click(screen.getByRole("button", { name: /details/ }))

    const detail = await screen.findByTestId("gateway-ticket-detail-rt_abc123")
    for (const operation of ["chat", "count-tokens", "models"]) {
      expect(within(detail).getByText(operation)).toBeInTheDocument()
    }
    expect(screen.getByTestId("gateway-ticket-budget-rt_abc123")).toHaveTextContent(
      "budgetUnmetered"
    )
  })

  it("re-reads the list on a timer while enabled, since tickets expire on their own", async () => {
    jest.useFakeTimers()
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ gatewayAgentRouteTickets: true }))
      render(<GatewayRouteTicketsPanel />)
      await act(async () => {})
      expect(mockList).toHaveBeenCalledTimes(1)

      await act(async () => {
        jest.advanceTimersByTime(15_000)
      })
      expect(mockList).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it("surfaces a failed revoke instead of silently leaving the row", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ gatewayAgentRouteTickets: true }))
    mockList.mockResolvedValue([ticket()])
    mockRevoke.mockRejectedValue(new Error("gateway is not running"))
    const { toast } = jest.requireMock("sonner")

    render(<GatewayRouteTicketsPanel />)
    await screen.findByText("rt_abc123")

    fireEvent.click(screen.getByRole("button", { name: "revokeAria:rt_abc123" }))
    fireEvent.click(await screen.findByRole("button", { name: "revokeConfirmAction" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("gateway is not running"))
    expect(screen.getByText("rt_abc123")).toBeInTheDocument()
  })

  it("cannot revoke an already-revoked ticket twice", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ gatewayAgentRouteTickets: true }))
    mockList.mockResolvedValue([ticket({ revoked: true })])

    render(<GatewayRouteTicketsPanel />)
    await screen.findByText("rt_abc123")

    expect(screen.getByRole("button", { name: "revokeAria:rt_abc123" })).toBeDisabled()
    expect(screen.getByText("statusRevoked")).toBeInTheDocument()
  })

  it("renders an empty list rather than crashing when the gateway is stopped", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ gatewayAgentRouteTickets: true }))
    mockList.mockRejectedValue(new Error("gateway is not running"))

    render(<GatewayRouteTicketsPanel />)

    expect(await screen.findByTestId("gateway-tickets-empty")).toBeInTheDocument()
  })
})
