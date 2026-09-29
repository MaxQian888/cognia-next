import type { ChatSession } from "@cognia/agent-config-types"
import {
  MAX_TRIGGERED_REPORTS_PER_HOUR,
  REPORT_COALESCE_MS,
  REPORT_SUMMARY_MAX_CHARS,
  REPORT_TTL_MS,
  __resetThreadReportsForTesting,
  flushThreadReports,
  renderThreadReports,
  reportThreadToCoordinator,
  type ReportDeps,
  type ThreadReport,
} from "./report"

const report = (threadId: string, extra: Partial<ThreadReport> = {}): ThreadReport => ({
  threadId,
  coordinatorSessionId: "coord",
  title: `Task ${threadId}`,
  outcome: "completed",
  summary: `Result of ${threadId}`,
  ...extra,
})

function setup() {
  let now = 1_000_000
  const timers: Array<{ fn: () => void; ms: number }> = []
  const rows = new Map<string, ChatSession>(
    ["t1", "t2"].map((id) => [
      id,
      {
        id,
        title: id,
        createdAt: 1,
        updatedAt: 1,
        projectThread: { coordinatorSessionId: "coord", brief: "b", proposedBy: "coordinator" },
      } as ChatSession,
    ])
  )
  const deps: ReportDeps = {
    send: jest.fn(async () => undefined),
    getSession: async (id) => rows.get(id),
    updateSession: jest.fn(async (id, patch) => {
      rows.set(id, { ...rows.get(id)!, ...patch })
    }),
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    now: () => now,
    isPaused: jest.fn(() => false),
  }
  return { deps, timers, rows, advance: (ms: number) => (now += ms) }
}

beforeEach(() => __resetThreadReportsForTesting())

describe("renderThreadReports", () => {
  it("renders one section per thread and truncates long summaries", () => {
    const text = renderThreadReports([
      report("t1", { declaredState: "ready-for-review" }),
      report("t2", { outcome: "error", summary: "x".repeat(REPORT_SUMMARY_MAX_CHARS + 50) }),
    ])
    expect(text).toContain('### Thread "Task t1" (t1) — completed · declared: ready-for-review')
    expect(text).toContain('### Thread "Task t2" (t2) — error')
    expect(text).toContain(`${"x".repeat(REPORT_SUMMARY_MAX_CHARS - 1)}…`)
    expect(renderThreadReports([report("t1", { summary: " " })])).toContain("(no summary)")
  })
})

describe("reportThreadToCoordinator", () => {
  it("coalesces reports in the window into one triggering message", async () => {
    const { deps, timers, rows } = setup()
    reportThreadToCoordinator(report("t1"), deps)
    reportThreadToCoordinator(report("t2"), deps)
    reportThreadToCoordinator(report("t1", { summary: "newer" }), deps)
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(REPORT_COALESCE_MS)
    await flushThreadReports("coord")

    expect(deps.send).toHaveBeenCalledTimes(1)
    const input = (deps.send as jest.Mock).mock.calls[0][0]
    expect(input).toMatchObject({
      senderSessionId: "t2",
      receiverSessionId: "coord",
      intent: "trigger_turn",
      origin: "agent",
      ttlMs: REPORT_TTL_MS,
    })
    expect(input.content).toContain("newer")
    expect(input.content).not.toContain("Result of t1")
    expect(rows.get("t1")?.projectThread?.lastReportAt).toBe(1_000_000)
  })

  it("downgrades to a note past the hourly trigger budget, then recovers", async () => {
    const { deps, advance } = setup()
    for (let i = 0; i < MAX_TRIGGERED_REPORTS_PER_HOUR + 1; i += 1) {
      reportThreadToCoordinator(report("t1", { summary: `run ${i}` }), deps)
      await flushThreadReports("coord")
      advance(1_000)
    }
    const intents = (deps.send as jest.Mock).mock.calls.map((call) => call[0].intent)
    expect(intents.filter((i) => i === "trigger_turn")).toHaveLength(MAX_TRIGGERED_REPORTS_PER_HOUR)
    expect(intents.at(-1)).toBe("note")

    advance(60 * 60 * 1000)
    reportThreadToCoordinator(report("t1", { summary: "later" }), deps)
    await flushThreadReports("coord")
    expect((deps.send as jest.Mock).mock.calls.at(-1)[0].intent).toBe("trigger_turn")
  })

  it("keeps going when the channel refuses the report", async () => {
    const { deps } = setup()
    ;(deps.send as jest.Mock).mockRejectedValueOnce(new Error("pii"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    reportThreadToCoordinator(report("t1"), deps)
    await expect(flushThreadReports("coord")).resolves.toBeUndefined()
    expect(deps.updateSession).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("reports to a paused project", () => {
  it("arrive as notes and do not spend the hourly trigger budget", async () => {
    const { deps } = setup()
    ;(deps.isPaused as jest.Mock).mockReturnValue(true)
    for (let i = 0; i < MAX_TRIGGERED_REPORTS_PER_HOUR + 1; i++) {
      reportThreadToCoordinator(report("t1", { summary: `r${i}` }), deps)
      await flushThreadReports("coord")
    }
    const intents = (deps.send as jest.Mock).mock.calls.map(([input]) => input.intent)
    expect(intents.every((intent) => intent === "note")).toBe(true)

    ;(deps.isPaused as jest.Mock).mockReturnValue(false)
    reportThreadToCoordinator(report("t1"), deps)
    await flushThreadReports("coord")
    expect((deps.send as jest.Mock).mock.calls.at(-1)[0].intent).toBe("trigger_turn")
  })
})
