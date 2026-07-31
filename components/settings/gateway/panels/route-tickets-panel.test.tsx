/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import {
  GatewayRouteTicketsPanel,
  routeTicketsDisabledDuringPrerender,
} from "./route-tickets-panel"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
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

describe("routeTicketsDisabledDuringPrerender", () => {
  it("reports the capability off, so the static export and hydration agree", () => {
    // localStorage does not exist during the static export. Any other answer
    // would render "on" server-side for a user who had enabled it, which React
    // reports as a hydration mismatch.
    expect(routeTicketsDisabledDuringPrerender()).toBe(false)
  })
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

    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith("rt_abc123"))
    expect(mockList).toHaveBeenCalledTimes(2)
  })

  it("surfaces a failed revoke instead of silently leaving the row", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ gatewayAgentRouteTickets: true }))
    mockList.mockResolvedValue([ticket()])
    mockRevoke.mockRejectedValue(new Error("gateway is not running"))
    const { toast } = jest.requireMock("sonner")

    render(<GatewayRouteTicketsPanel />)
    await screen.findByText("rt_abc123")

    fireEvent.click(screen.getByRole("button", { name: "revokeAria:rt_abc123" }))

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
