import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { appendLoopEvent, createLoop } from "@/lib/db/loops"
import type { Loop } from "@/types/loop"
import { LoopActivityTab } from "./activity-tab"

const loop: Loop = {
  id: "lp1",
  sessionId: "ses_a",
  mode: "self_paced",
  rawPrompt: "p",
  safePrompt: "p",
  redactionMapEnc: "",
  isSlashCommand: false,
  status: "active",
  iterations: 1,
  tokensUsed: 0,
  generationId: "gen-1",
  config: {
    maxIterations: 100,
    maxTokens: 1_000_000,
    minDelayMs: 60_000,
    maxDelayMs: 3_600_000,
    maxParseFailures: 3,
  },
  parseFailureCount: 0,
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await createLoop({ ...loop })
})

describe("LoopActivityTab", () => {
  it("shows the empty state when no events exist", async () => {
    render(<LoopActivityTab loop={loop} />)
    await waitFor(() => expect(screen.getByTestId("loop-activity-empty")).toBeInTheDocument())
  })

  it("renders events newest-first with kind-specific summaries", async () => {
    await appendLoopEvent({
      loopId: "lp1",
      kind: "iteration_completed",
      payload: { kind: "iteration_completed", iteration: 1, tokensDelta: 42 },
      ts: 1,
    })
    await appendLoopEvent({
      loopId: "lp1",
      kind: "delay_decided",
      payload: { kind: "delay_decided", delayMs: 300_000, reason: "build running" },
      ts: 2,
    })
    render(<LoopActivityTab loop={loop} />)
    await waitFor(() => expect(screen.getByTestId("loop-activity-list")).toBeInTheDocument())
    const items = screen.getAllByRole("listitem")
    expect(items[0]).toHaveTextContent("delay_decided")
    expect(items[0]).toHaveTextContent(/build running/)
    expect(items[1]).toHaveTextContent("iteration_completed")
  })

  it("summarises exits with the reason", async () => {
    await appendLoopEvent({
      loopId: "lp1",
      kind: "exit_triggered",
      payload: { kind: "exit_triggered", exit: "completed", reason: "report delivered" },
    })
    render(<LoopActivityTab loop={loop} />)
    await waitFor(() => expect(screen.getByText(/report delivered/)).toBeInTheDocument())
  })
})
