/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import type { UseRunEstimateResult } from "@/hooks/usage/use-run-estimate"

jest.mock("@/hooks/usage/use-run-estimate", () => ({ useRunEstimate: jest.fn() }))

import { useRunEstimate } from "@/hooks/usage/use-run-estimate"

import { RunEstimateHint } from "./run-estimate-hint"

const hookMock = useRunEstimate as jest.Mock

function mockResult(result: UseRunEstimateResult) {
  hookMock.mockReturnValue(result)
}

describe("RunEstimateHint", () => {
  it("renders nothing while loading, idle or failed", () => {
    for (const status of ["loading", "idle", "error"] as const) {
      mockResult({ status, estimate: null, dormant: false })
      const { container, unmount } = render(<RunEstimateHint queries={[{ surface: "goal" }]} />)
      expect(container).toBeEmptyDOMElement()
      unmount()
    }
  })

  it("renders the estimate line with its confidence", () => {
    mockResult({
      status: "ready",
      dormant: false,
      estimate: {
        confidence: "few",
        sampleCount: 7,
        tokens: { p10: 50_000, p50: 180_000, p90: 520_000 },
        costUsd: { p10: 0.8, p50: 2.1, p90: 5.4 },
        durationMs: null,
        stoppedShare: 0.25,
      },
    })
    render(<RunEstimateHint queries={[{ surface: "goal" }]} data-testid="hint" />)
    const hint = screen.getByTestId("hint")
    expect(hint).toHaveAttribute("data-confidence", "few")
    expect(hint).toHaveTextContent("≈ $2.10 at API prices ($0.80–$5.40)")
    expect(hint).toHaveTextContent("~180.0K tokens (50.0K–520.0K)")
    expect(hint).toHaveTextContent("only 7 similar runs so far")
    expect(hint).toHaveTextContent("25% of them stopped early")
    expect(hookMock).toHaveBeenLastCalledWith([{ surface: "goal" }])
  })

  it("says there is no estimate yet when history is empty", () => {
    mockResult({
      status: "ready",
      dormant: false,
      estimate: {
        confidence: "none",
        sampleCount: 0,
        tokens: null,
        costUsd: null,
        durationMs: null,
        stoppedShare: null,
      },
    })
    render(<RunEstimateHint queries={[{ surface: "goal" }]} />)
    expect(screen.getByTestId("run-estimate-hint")).toHaveTextContent(
      "No estimate yet: not enough similar runs"
    )
  })

  it("labels a dormant surface as inert", () => {
    mockResult({ status: "ready", estimate: null, dormant: true })
    render(<RunEstimateHint queries={[{ surface: "bot" }]} />)
    const hint = screen.getByTestId("run-estimate-hint")
    expect(hint).toHaveAttribute("data-confidence", "dormant")
    expect(hint).toHaveTextContent("No estimate yet: bot runs do not record usage")
  })
})
