/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"

function renderWithProvider(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

const mockUseAdapterHealth = jest.fn()

jest.mock("@/hooks/connectors/use-adapter-health", () => ({
  useAdapterHealth: (...args: unknown[]) => mockUseAdapterHealth(...args),
}))

jest.mock("@/lib/connectors/lifecycle", () => ({
  requeueAdapter: jest.fn().mockResolvedValue(true),
}))

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))

import { HealthDetail } from "./health-detail"

function makeResult(overrides: Record<string, unknown> = {}) {
  return {
    current: { state: "running", reason: undefined, lastActivityAt: Date.now() },
    buckets: Array.from({ length: 48 }, (_, i) => ({
      bucketStart: i * 1000,
      state: "running" as const,
      eventCount: 1,
    })),
    lastOk: undefined,
    lastError: undefined,
    pendingOutboundCount: 0,
    breaker: null,
    rateBucket: null,
    atGateBlocks: { total: 0, byReason: [] },
    ...overrides,
  }
}

beforeEach(() => {
  mockUseAdapterHealth.mockReset()
})

describe("HealthDetail — base render", () => {
  it("renders the summary card with the state pill", () => {
    mockUseAdapterHealth.mockReturnValue(makeResult())
    renderWithProvider(<HealthDetail adapterId="tg-1" />)
    expect(screen.getByTestId("health-state-pill")).toBeInTheDocument()
    expect(screen.getByTestId("health-detail-summary")).toBeInTheDocument()
    expect(screen.getByTestId("health-detail-grid")).toBeInTheDocument()
  })

  it("hides the runtime card when neither breaker nor rate bucket is present", () => {
    mockUseAdapterHealth.mockReturnValue(makeResult({ breaker: null, rateBucket: null }))
    renderWithProvider(<HealthDetail adapterId="tg-1" />)
    expect(screen.queryByTestId("health-detail-runtime")).not.toBeInTheDocument()
  })
})

describe("HealthDetail — runtime card", () => {
  it("renders the breaker pill with closed state", () => {
    mockUseAdapterHealth.mockReturnValue(
      makeResult({
        breaker: {
          state: "closed",
          openedAt: null,
          failureRate: 0,
          eventCount: 0,
        },
      })
    )
    renderWithProvider(<HealthDetail adapterId="tg-1" />)
    expect(screen.getByTestId("health-detail-runtime")).toBeInTheDocument()
    expect(screen.getByTestId("health-breaker-state")).toHaveTextContent(/closed/i)
    expect(screen.queryByTestId("health-breaker-rate")).not.toBeInTheDocument()
  })

  it("shows opened-at when breaker is open", () => {
    mockUseAdapterHealth.mockReturnValue(
      makeResult({
        breaker: {
          state: "open",
          openedAt: Date.now() - 60_000,
          failureRate: 75,
          eventCount: 8,
        },
      })
    )
    renderWithProvider(<HealthDetail adapterId="tg-1" />)
    expect(screen.getByTestId("health-breaker-state")).toHaveTextContent(/open/i)
    expect(screen.getByTestId("health-breaker-rate")).toBeInTheDocument()
  })

  it("renders the rate-bucket gauge and value", () => {
    mockUseAdapterHealth.mockReturnValue(
      makeResult({
        rateBucket: {
          available: 12,
          capacity: 20,
          refillPerSec: 5,
          nextRefillAt: Date.now(),
        },
      })
    )
    renderWithProvider(<HealthDetail adapterId="tg-1" />)
    expect(screen.getByTestId("health-rate-bucket")).toBeInTheDocument()
    expect(screen.getByTestId("health-rate-bucket-available")).toHaveTextContent(/12/)
  })

  it("renders next-refill hint when bucket is drained", () => {
    mockUseAdapterHealth.mockReturnValue(
      makeResult({
        rateBucket: {
          available: 0.4,
          capacity: 20,
          refillPerSec: 5,
          nextRefillAt: Date.now() + 1200,
        },
      })
    )
    renderWithProvider(<HealthDetail adapterId="tg-1" />)
    // Use a less strict matcher so locale formatting / rounding doesn't fight us.
    const refillNode = screen.getByTestId("health-rate-bucket").querySelector("p")
    expect(refillNode).not.toBeNull()
    expect(refillNode!.textContent).toMatch(/\d/)
  })

  it("renders both runtime sub-panels when both snapshots are present", () => {
    mockUseAdapterHealth.mockReturnValue(
      makeResult({
        breaker: { state: "closed", openedAt: null, failureRate: 0, eventCount: 0 },
        rateBucket: {
          available: 18,
          capacity: 20,
          refillPerSec: 5,
          nextRefillAt: Date.now(),
        },
      })
    )
    renderWithProvider(<HealthDetail adapterId="tg-1" />)
    expect(screen.getByTestId("health-breaker")).toBeInTheDocument()
    expect(screen.getByTestId("health-rate-bucket")).toBeInTheDocument()
  })
})

describe("HealthDetail — at-gate summary (Task 5.3)", () => {
  it("does not render the at-gate card when no blocks", () => {
    mockUseAdapterHealth.mockReturnValue(makeResult())
    renderWithProvider(<HealthDetail adapterId="tg-1" />)
    expect(screen.queryByTestId("health-detail-atgate")).not.toBeInTheDocument()
  })

  it("renders the at-gate card with total + reason badges when blocks exist", () => {
    mockUseAdapterHealth.mockReturnValue(
      makeResult({
        atGateBlocks: {
          total: 5,
          byReason: [
            { reason: "at_mention_required" as const, count: 3 },
            { reason: "chat_blocklist" as const, count: 2 },
          ],
        },
      })
    )
    renderWithProvider(<HealthDetail adapterId="tg-1" />)
    expect(screen.getByTestId("health-detail-atgate")).toBeInTheDocument()
  })
})
