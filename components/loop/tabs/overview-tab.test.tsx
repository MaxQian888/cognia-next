import { render, screen } from "@testing-library/react"
import type { Loop } from "@/types/loop"
import { LoopOverviewTab } from "./overview-tab"

const base: Loop = {
  id: "lp1",
  sessionId: "ses_a",
  mode: "self_paced",
  rawPrompt: "summarize new commits",
  safePrompt: "summarize new commits",
  redactionMapEnc: "",
  isSlashCommand: false,
  status: "active",
  iterations: 4,
  tokensUsed: 2_500,
  generationId: "gen-1",
  config: {
    maxIterations: 100,
    maxTokens: 1_000_000,
    minDelayMs: 60_000,
    maxDelayMs: 3_600_000,
    maxParseFailures: 3,
  },
  parseFailureCount: 0,
  expiresAt: Date.UTC(2026, 5, 14),
  createdAt: Date.UTC(2026, 5, 7),
  updatedAt: Date.UTC(2026, 5, 7),
}

describe("LoopOverviewTab", () => {
  it("renders the prompt, progress meters, and mode badge", () => {
    render(<LoopOverviewTab loop={base} />)
    expect(screen.getByText("summarize new commits")).toBeInTheDocument()
    expect(screen.getByText("4 / 100")).toBeInTheDocument()
    expect(screen.getByText("2,500 / 1,000,000")).toBeInTheDocument()
    expect(screen.getByTestId("loop-mode-badge")).toBeInTheDocument()
  })

  it("shows the interval cadence for interval loops", () => {
    render(<LoopOverviewTab loop={{ ...base, mode: "interval", intervalMs: 5 * 60_000 }} />)
    expect(screen.getByTestId("loop-mode-badge").textContent).toMatch(/5/)
  })

  it("shows the expiry badge while running and the ended badge when terminal", () => {
    const { unmount } = render(<LoopOverviewTab loop={base} />)
    expect(screen.getByText(/Expires:/)).toBeInTheDocument()
    unmount()
    render(<LoopOverviewTab loop={{ ...base, status: "stopped", endedAt: Date.UTC(2026, 5, 8) }} />)
    expect(screen.getByText(/Ended:/)).toBeInTheDocument()
    expect(screen.queryByText(/Expires:/)).toBeNull()
  })

  it("renders the last delay reason for self-paced loops", () => {
    render(<LoopOverviewTab loop={{ ...base, nextDelayReason: "waiting on CI" }} />)
    expect(screen.getByText(/waiting on CI/)).toBeInTheDocument()
  })
})
