/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

let mockRecent:
  | Array<{
      adapterId: string
      kind: string
      at: number
      reason?: string
      fields?: Record<string, unknown>
    }>
  | undefined = []

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn().mockImplementation(() => mockRecent),
}))

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

const mockRequeue = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/connectors/lifecycle", () => ({
  requeueAdapter: (...args: unknown[]) => mockRequeue(...args),
}))

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}))

import { ConnectionLossBanner } from "./connection-loss-banner"

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as unknown as Record<string, unknown>}>
      {ui}
    </NextIntlClientProvider>
  )
}

function heartbeat(
  adapterId: string,
  state: "running" | "degraded" | "down" | "starting",
  reason?: string,
  at = Date.now()
) {
  return {
    adapterId,
    kind: "adapter.heartbeat",
    at,
    reason,
    fields: { state, reason },
  }
}

beforeEach(() => {
  if (typeof window !== "undefined") {
    window.localStorage.clear()
  }
  mockRequeue.mockClear()
  mockRecent = []
})

describe("ConnectionLossBanner", () => {
  it("renders nothing when no adapters are degraded", () => {
    mockRecent = [heartbeat("lark-1", "running")]
    const { container } = wrap(<ConnectionLossBanner />)
    expect(container.querySelector("[data-testid='connection-loss-banner']")).toBeNull()
  })

  it("surfaces degraded adapters with per-row reconnect buttons", () => {
    mockRecent = [
      heartbeat("lark-1", "degraded", "lark_ping_failed"),
      heartbeat("onebot-1", "down"),
    ]
    wrap(<ConnectionLossBanner />)
    expect(screen.getByTestId("connection-loss-banner")).toBeInTheDocument()
    expect(screen.getByTestId("connection-loss-row-lark-1")).toBeInTheDocument()
    expect(screen.getByTestId("connection-loss-row-onebot-1")).toBeInTheDocument()
    expect(screen.getByTestId("connection-loss-reconnect-lark-1")).toBeInTheDocument()
    expect(screen.getByTestId("connection-loss-reconnect-onebot-1")).toBeInTheDocument()
  })

  it("renders 'reconnect all' only when more than one adapter is down", () => {
    mockRecent = [heartbeat("only-one", "degraded")]
    wrap(<ConnectionLossBanner />)
    expect(screen.queryByTestId("connection-loss-reconnect-all")).not.toBeInTheDocument()

    mockRecent = [heartbeat("a", "degraded"), heartbeat("b", "degraded")]
    wrap(<ConnectionLossBanner />)
    expect(screen.getByTestId("connection-loss-reconnect-all")).toBeInTheDocument()
  })

  it("clicking reconnect drives requeueAdapter", async () => {
    mockRecent = [heartbeat("lark-1", "degraded")]
    wrap(<ConnectionLossBanner />)
    fireEvent.click(screen.getByTestId("connection-loss-reconnect-lark-1"))
    await waitFor(() => expect(mockRequeue).toHaveBeenCalledWith("lark-1"))
  })

  it("dismiss persists per-set hash in localStorage", () => {
    mockRecent = [heartbeat("lark-1", "degraded"), heartbeat("b", "down")]
    wrap(<ConnectionLossBanner />)
    fireEvent.click(screen.getByTestId("connection-loss-dismiss"))
    expect(window.localStorage.getItem("inbox.connectionLossBanner.dismiss")).not.toBeNull()
  })

  it("dismiss is per-set: a new failing set re-renders the banner", () => {
    mockRecent = [heartbeat("lark-1", "degraded")]
    const { rerender } = wrap(<ConnectionLossBanner />)
    fireEvent.click(screen.getByTestId("connection-loss-dismiss"))
    // Same set — stays hidden.
    rerender(
      <NextIntlClientProvider
        locale="en"
        messages={enMessages as unknown as Record<string, unknown>}
      >
        <ConnectionLossBanner />
      </NextIntlClientProvider>
    )
    expect(screen.queryByTestId("connection-loss-banner")).not.toBeInTheDocument()

    // Different set — shows up again because the hash changed.
    mockRecent = [heartbeat("onebot-1", "down")]
    rerender(
      <NextIntlClientProvider
        locale="en"
        messages={enMessages as unknown as Record<string, unknown>}
      >
        <ConnectionLossBanner />
      </NextIntlClientProvider>
    )
    expect(screen.getByTestId("connection-loss-banner")).toBeInTheDocument()
  })

  it("ignores starting + running states (only degraded/down surface)", () => {
    mockRecent = [heartbeat("a", "starting"), heartbeat("b", "running")]
    wrap(<ConnectionLossBanner />)
    expect(screen.queryByTestId("connection-loss-banner")).not.toBeInTheDocument()
  })
})
