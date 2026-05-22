/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

// ── mocks ────────────────────────────────────────────────────────────
//
// The badge is a thin wrapper around `useAdapterHealth`. We mock that
// hook directly so each test can exercise a specific health shape
// without standing up Dexie + audit-row fixtures.

let mockHealth: Partial<
  ReturnType<typeof import("@/hooks/connectors/use-adapter-health").useAdapterHealth>
> = {
  current: { state: "running", lastActivityAt: 0 } as unknown as ReturnType<
    typeof import("@/hooks/connectors/use-adapter-health").useAdapterHealth
  >["current"],
  buckets: [],
  pendingOutboundCount: 0,
  breaker: null,
  rateBucket: null,
  atGateBlocks: { count: 0, topReasons: [] } as unknown as ReturnType<
    typeof import("@/hooks/connectors/use-adapter-health").useAdapterHealth
  >["atGateBlocks"],
}

jest.mock("@/hooks/connectors/use-adapter-health", () => ({
  useAdapterHealth: jest.fn(() => mockHealth),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

const mockRequeue = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/connectors/lifecycle", () => ({
  requeueAdapter: (...args: unknown[]) => mockRequeue(...args),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

jest.mock("next/link", () => {
  const Link = ({
    href,
    children,
    ...rest
  }: {
    href: string
    children: React.ReactNode
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  )
  Link.displayName = "MockNextLink"
  return { __esModule: true, default: Link }
})

import { AdapterHealthBadge, __TESTING__ } from "./adapter-health-badge"

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as unknown as Record<string, unknown>}>
      {ui}
    </NextIntlClientProvider>
  )
}

function resetHealth(overrides: Partial<typeof mockHealth>): void {
  mockHealth = {
    current: { state: "running", lastActivityAt: 0 } as unknown as typeof mockHealth.current,
    buckets: [],
    pendingOutboundCount: 0,
    breaker: null,
    rateBucket: null,
    atGateBlocks: { count: 0, topReasons: [] } as unknown as typeof mockHealth.atGateBlocks,
    ...overrides,
  }
}

beforeEach(() => {
  mockRequeue.mockClear()
  resetHealth({})
})

describe("decideBadge predicate", () => {
  it("returns null when the adapter is nominal", () => {
    resetHealth({})
    const decision = __TESTING__.decideBadge(
      mockHealth as unknown as ReturnType<
        typeof import("@/hooks/connectors/use-adapter-health").useAdapterHealth
      >
    )
    expect(decision).toBeNull()
  })

  it("prefers breaker-open over rate-limited and degraded", () => {
    resetHealth({
      breaker: { state: "open", openedAt: 100, failureRate: 90, eventCount: 10 },
      rateBucket: { available: 0, capacity: 20, refillPerSec: 5, nextRefillAt: 200 },
      current: { state: "degraded", lastActivityAt: 0 } as unknown as typeof mockHealth.current,
    })
    expect(
      __TESTING__.decideBadge(
        mockHealth as unknown as ReturnType<
          typeof import("@/hooks/connectors/use-adapter-health").useAdapterHealth
        >
      )?.state
    ).toBe("breaker-open")
  })

  it("returns rate-limited when bucket is exhausted (and breaker is closed)", () => {
    resetHealth({
      breaker: { state: "closed", openedAt: null, failureRate: 0, eventCount: 0 },
      rateBucket: { available: 0, capacity: 20, refillPerSec: 5, nextRefillAt: 999 },
      current: { state: "running", lastActivityAt: 0 } as unknown as typeof mockHealth.current,
    })
    const decision = __TESTING__.decideBadge(
      mockHealth as unknown as ReturnType<
        typeof import("@/hooks/connectors/use-adapter-health").useAdapterHealth
      >
    )
    expect(decision?.state).toBe("rate-limited")
    expect(decision?.etaMs).toBe(999)
  })

  it("returns degraded / down from current.state when no breaker/rate signal", () => {
    resetHealth({
      current: { state: "degraded", lastActivityAt: 0 } as unknown as typeof mockHealth.current,
    })
    expect(
      __TESTING__.decideBadge(
        mockHealth as unknown as ReturnType<
          typeof import("@/hooks/connectors/use-adapter-health").useAdapterHealth
        >
      )?.state
    ).toBe("degraded")

    resetHealth({
      current: { state: "down", lastActivityAt: 0 } as unknown as typeof mockHealth.current,
    })
    expect(
      __TESTING__.decideBadge(
        mockHealth as unknown as ReturnType<
          typeof import("@/hooks/connectors/use-adapter-health").useAdapterHealth
        >
      )?.state
    ).toBe("down")
  })
})

describe("AdapterHealthBadge — rendering", () => {
  it("renders nothing when health is nominal", () => {
    resetHealth({})
    const { container } = wrap(<AdapterHealthBadge adapterId="tg-1" />)
    expect(container.querySelector("[data-testid='adapter-health-badge']")).toBeNull()
  })

  it("renders the badge with the right state label when breaker is open", () => {
    resetHealth({
      breaker: { state: "open", openedAt: Date.now(), failureRate: 90, eventCount: 10 },
      lastError: { id: "e1", adapterId: "tg-1", kind: "delivery.error", at: 0, message: "boom" },
    })
    wrap(<AdapterHealthBadge adapterId="tg-1" />)
    expect(screen.getByTestId("adapter-health-badge")).toBeInTheDocument()
  })

  it("clicking the badge opens the popover with reason + reconnect button", async () => {
    resetHealth({
      breaker: { state: "open", openedAt: Date.now(), failureRate: 90, eventCount: 10 },
      lastError: { id: "e1", adapterId: "tg-1", kind: "delivery.error", at: 0, message: "boom" },
    })
    wrap(<AdapterHealthBadge adapterId="tg-1" />)
    fireEvent.click(screen.getByTestId("adapter-health-badge"))
    await waitFor(() => {
      expect(screen.getByTestId("adapter-health-popover")).toBeInTheDocument()
      expect(screen.getByTestId("adapter-health-reason")).toHaveTextContent("boom")
      expect(screen.getByTestId("adapter-health-reconnect")).toBeInTheDocument()
    })
  })

  it("reconnect button triggers requeueAdapter", async () => {
    resetHealth({
      breaker: { state: "open", openedAt: Date.now(), failureRate: 90, eventCount: 10 },
    })
    wrap(<AdapterHealthBadge adapterId="tg-1" />)
    fireEvent.click(screen.getByTestId("adapter-health-badge"))
    await waitFor(() => screen.getByTestId("adapter-health-reconnect"))
    fireEvent.click(screen.getByTestId("adapter-health-reconnect"))
    await waitFor(() => {
      expect(mockRequeue).toHaveBeenCalledWith("tg-1")
    })
  })
})
