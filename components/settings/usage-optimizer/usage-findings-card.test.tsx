/**
 * The card's job is to present a claim WITH its provenance. These tests pin
 * the three parts that make it honest: the measured/estimated label, the
 * evidence line, and that external spend never produces a finding here.
 */

let liveRows: unknown[] | undefined = []
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => liveRows }))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ sessionUsage: {} }) }))
jest.mock("@/lib/subscription/core/now-ticker", () => ({
  useSubscriptionNow: () => new Date(2026, 5, 5, 12, 0, 0).getTime(),
}))

import { render, screen } from "@testing-library/react"

import { FINDING_PERIODS, UsageFindingsCard } from "./usage-findings-card"
import type { SessionUsageRow } from "@/lib/db/session-usage"

const T0 = new Date(2026, 5, 5, 12, 0, 0).getTime()

function row(over: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: "m1",
    sessionId: "s1",
    at: T0,
    model: "claude-opus-4",
    providerId: "anthropic",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 2,
    durationMs: 0,
    costSource: "sdk",
    costKnown: true,
    ...over,
  }
}

const coldCache = Array.from({ length: 40 }, (_, i) => row({ messageId: `m${i}` }))

beforeEach(() => {
  liveRows = []
})

describe("FINDING_PERIODS", () => {
  it("excludes today, which is too short to find a habit in", () => {
    expect(FINDING_PERIODS).not.toContain("today")
    expect(FINDING_PERIODS.length).toBeGreaterThan(0)
  })
})

describe("UsageFindingsCard", () => {
  it("says so while the first read is in flight", () => {
    liveRows = undefined
    render(<UsageFindingsCard />)
    expect(screen.getByTestId("findings-loading")).toBeInTheDocument()
  })

  it("says nothing stands out rather than rendering an empty list", () => {
    render(<UsageFindingsCard />)
    expect(screen.getByTestId("findings-empty")).toBeInTheDocument()
  })

  it("renders a finding with its title and body", () => {
    liveRows = coldCache
    render(<UsageFindingsCard />)
    expect(screen.getByTestId("finding-cacheColdStarts")).toBeInTheDocument()
    expect(screen.getByText(/Prompt caching is not paying off/)).toBeInTheDocument()
  })

  it("labels an estimate as an estimate", () => {
    liveRows = coldCache
    render(<UsageFindingsCard />)
    expect(screen.getByTestId("finding-cacheColdStarts")).toHaveTextContent("Estimated")
  })

  it("labels measured spend as measured", () => {
    liveRows = [
      row({ messageId: "a", runId: "r", turnId: "t1", attemptId: "1", at: T0, costUsd: 5 }),
      row({ messageId: "b", runId: "r", turnId: "t1", attemptId: "2", at: T0 + 1, costUsd: 5 }),
      row({ messageId: "c", runId: "r", turnId: "t2", attemptId: "1", at: T0 + 2, costUsd: 5 }),
    ]
    render(<UsageFindingsCard />)
    expect(screen.getByTestId("finding-retrySpend")).toHaveTextContent("Measured")
  })

  it("shows the evidence a finding rests on", () => {
    liveRows = coldCache
    render(<UsageFindingsCard />)
    const evidence = screen.getAllByTestId("finding-evidence")[0]
    expect(evidence).toHaveTextContent("40 turns")
  })

  it("discloses unpriced turns inside the evidence line", () => {
    liveRows = [
      ...coldCache,
      ...Array.from({ length: 10 }, (_, i) =>
        row({ messageId: `u${i}`, costSource: "unknown", costKnown: false, costUsd: 0 })
      ),
    ]
    render(<UsageFindingsCard />)
    expect(screen.getAllByTestId("finding-evidence")[0]).toHaveTextContent("unpriced")
  })

  it("never raises a finding about another tool's bill", () => {
    // External spend is not a habit this app can help with, and a finding the
    // user cannot act on is worse than none.
    liveRows = coldCache.map((r) => ({ ...r, sourceId: "codex", imported: true }))
    render(<UsageFindingsCard />)
    expect(screen.getByTestId("findings-empty")).toBeInTheDocument()
  })

  it("offers an analysis window picker", () => {
    render(<UsageFindingsCard />)
    expect(screen.getByLabelText("Analysis window")).toBeInTheDocument()
  })
})
