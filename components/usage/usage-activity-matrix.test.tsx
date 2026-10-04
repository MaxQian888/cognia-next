/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { buildActivityMatrix } from "@/lib/usage/usage-insights"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import { UsageActivityMatrix, activityLevel } from "./usage-activity-matrix"

function row(at: number): SessionUsageRow {
  return {
    messageId: String(at),
    sessionId: "s",
    at,
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0.5,
    costSource: "sdk",
    costKnown: true,
    durationMs: 0,
  }
}

describe("activityLevel", () => {
  it("reserves 0 for empty cells and scales the rest to 1–4", () => {
    expect(activityLevel(0, 10)).toBe(0)
    expect(activityLevel(1, 10)).toBe(1)
    expect(activityLevel(10, 10)).toBe(4)
    expect(activityLevel(3, 0)).toBe(0)
  })
})

describe("UsageActivityMatrix", () => {
  it("draws a Monday-first 7 × 24 grid and names the busiest slot", () => {
    const monday9 = new Date(2026, 4, 18, 9, 15).getTime()
    const matrix = buildActivityMatrix([row(monday9), row(monday9 + 1000)])
    render(<UsageActivityMatrix matrix={matrix} />)
    expect(screen.getAllByRole("gridcell")).toHaveLength(7 * 24)
    expect(screen.getAllByRole("rowheader")[0]).toHaveTextContent("Mon")
    const cell = screen.getByTestId("usage-activity-matrix-cell-1-9")
    expect(cell).toHaveAttribute("data-level", "4")
    expect(cell).toHaveAttribute("aria-label", "Mon 9:00 · 2 turns · $1.00")
    expect(screen.getByTestId("usage-activity-matrix-peak")).toHaveTextContent(
      "Busiest: Mon around 9:00 (2 turns)"
    )
  })

  it("shows an empty hint without activity", () => {
    render(<UsageActivityMatrix matrix={buildActivityMatrix([])} />)
    expect(screen.getByTestId("usage-activity-matrix-empty")).toBeInTheDocument()
  })
})
