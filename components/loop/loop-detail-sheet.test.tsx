import "fake-indexeddb/auto"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { Loop } from "@/types/loop"
import { LoopDetailSheet } from "./loop-detail-sheet"

jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: () => ({ deleteTask: jest.fn() }),
}))

const loop: Loop = {
  id: "lp1",
  sessionId: "ses_a",
  mode: "self_paced",
  rawPrompt: "summarize",
  safePrompt: "summarize",
  redactionMapEnc: "",
  isSlashCommand: false,
  status: "active",
  iterations: 2,
  tokensUsed: 500,
  generationId: "gen-1",
  config: {
    maxIterations: 100,
    maxTokens: 1_000_000,
    minDelayMs: 60_000,
    maxDelayMs: 3_600_000,
    maxParseFailures: 3,
  },
  parseFailureCount: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("LoopDetailSheet", () => {
  it("renders the three tabs and the overview by default", () => {
    render(<LoopDetailSheet loop={loop} open onOpenChange={() => {}} />)
    expect(screen.getByTestId("loop-tab-overview")).toBeInTheDocument()
    expect(screen.getByTestId("loop-tab-activity")).toBeInTheDocument()
    expect(screen.getByTestId("loop-tab-settings")).toBeInTheDocument()
    expect(screen.getByText(/Loop · active/)).toBeInTheDocument()
  })

  it("switches to the settings tab", async () => {
    render(<LoopDetailSheet loop={loop} open onOpenChange={() => {}} />)
    await userEvent.click(screen.getByTestId("loop-tab-settings"))
    expect(await screen.findByTestId("loop-settings-form")).toBeInTheDocument()
  })

  it("renders nothing while closed", () => {
    render(<LoopDetailSheet loop={loop} open={false} onOpenChange={() => {}} />)
    expect(screen.queryByTestId("loop-tab-overview")).toBeNull()
  })
})
