import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import { __resetGoalRuntimeForTesting } from "@/lib/goal/runtime"
import type { Loop } from "@/types/loop"
import { LoopStatusPill } from "./loop-status-pill"

const useBreakpointMock = jest.fn().mockReturnValue("desktop")
jest.mock("@/hooks/ui/use-breakpoint", () => ({
  useBreakpoint: () => useBreakpointMock(),
}))

const schedulerMock = {
  createTask: jest.fn().mockResolvedValue({ id: "task_1" }),
  pauseTask: jest.fn().mockResolvedValue(true),
  resumeTask: jest.fn().mockResolvedValue(true),
  deleteTask: jest.fn().mockResolvedValue(true),
}
jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: () => schedulerMock,
}))

import { __resetLoopRuntimeForTesting, getLoopRuntime } from "@/lib/loop/runtime"

const baseLoop: Loop = {
  id: "lp1",
  sessionId: "ses_a",
  mode: "self_paced",
  rawPrompt: "summarize new commits",
  safePrompt: "summarize new commits",
  redactionMapEnc: "",
  isSlashCommand: false,
  status: "active",
  iterations: 3,
  tokensUsed: 12_340,
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
  await __resetRedactionKey()
  __resetLoopRuntimeForTesting()
  __resetGoalRuntimeForTesting()
  useBreakpointMock.mockReset().mockReturnValue("desktop")
})

describe("LoopStatusPill", () => {
  it("renders nothing when loopOverride is null", () => {
    const { container } = render(<LoopStatusPill sessionId="ses_a" loopOverride={null} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders prompt + status + progress for an active self-paced loop", () => {
    render(<LoopStatusPill sessionId="ses_a" loopOverride={baseLoop} />)
    expect(screen.getByTestId("loop-status-pill")).toBeInTheDocument()
    expect(screen.getByText("summarize new commits")).toBeInTheDocument()
    expect(screen.getByText(/3\/100/)).toBeInTheDocument()
  })

  it("shows the model-chosen delay footnote when stored", () => {
    render(
      <LoopStatusPill
        sessionId="ses_a"
        loopOverride={{ ...baseLoop, nextDelayMs: 300_000, nextDelayReason: "build running" }}
      />
    )
    expect(screen.getByTestId("activity-pill-footnote")).toHaveTextContent(/build running/)
  })

  it("omits the footnote for interval loops", () => {
    render(
      <LoopStatusPill
        sessionId="ses_a"
        loopOverride={{ ...baseLoop, mode: "interval", intervalMs: 300_000, nextDelayMs: 60_000 }}
      />
    )
    expect(screen.queryByTestId("activity-pill-footnote")).toBeNull()
  })

  it("shows Pause when active, Resume when paused", () => {
    const { unmount } = render(<LoopStatusPill sessionId="ses_a" loopOverride={baseLoop} />)
    expect(screen.getByTestId("loop-pause-button")).toBeInTheDocument()
    expect(screen.queryByTestId("loop-resume-button")).toBeNull()
    unmount()
    render(<LoopStatusPill sessionId="ses_a" loopOverride={{ ...baseLoop, status: "paused" }} />)
    expect(screen.getByTestId("loop-resume-button")).toBeInTheDocument()
    expect(screen.queryByTestId("loop-pause-button")).toBeNull()
  })

  it("clicking Pause routes through the runtime", async () => {
    const loop = await getLoopRuntime().createLoop({
      sessionId: "ses_a",
      rawPrompt: "x",
      mode: "self_paced",
    })
    render(<LoopStatusPill sessionId="ses_a" loopOverride={loop} />)
    fireEvent.click(screen.getByTestId("loop-pause-button"))
    await waitFor(async () => {
      const updated = await getLoopRuntime().getOpenLoopForSession("ses_a")
      expect(updated?.status).toBe("paused")
    })
  })

  it("clicking the details action opens the detail sheet", () => {
    render(<LoopStatusPill sessionId="ses_a" loopOverride={baseLoop} />)
    fireEvent.click(screen.getByTestId("loop-show-button"))
    expect(screen.getByText(/Loop · active/)).toBeInTheDocument()
  })

  it("collapses stop/details behind the more menu on mobile", async () => {
    useBreakpointMock.mockReturnValue("mobile")
    render(<LoopStatusPill sessionId="ses_a" loopOverride={baseLoop} />)
    expect(screen.getByTestId("loop-pause-button")).toBeInTheDocument()
    expect(screen.queryByTestId("loop-stop-button")).toBeNull()
    await userEvent.click(screen.getByTestId("activity-pill-more"))
    expect(await screen.findByTestId("loop-stop-button")).toBeInTheDocument()
  })
})
