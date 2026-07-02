import React from "react"
import { act, render } from "@testing-library/react"

import { BottomStatus, agentTreeRowTarget, type AgentTreeHit } from "./BottomStatus"
import type { SubagentLiveEntry } from "../../agent/subagent-live-output"
import type { ToolCell } from "../state/types"

const tool = (over: Partial<ToolCell> = {}): ToolCell => ({
  id: "t1",
  kind: "tool",
  callKey: "k1",
  toolName: "bash",
  input: { command: "npm test" },
  status: "running",
  collapsed: true,
  ...over,
})

const liveEntry = (over: Partial<SubagentLiveEntry> = {}): SubagentLiveEntry => ({
  liveId: "live-1",
  name: "Finder: Rust backend",
  task: "find the rust bits",
  sessionId: "s1",
  status: "running",
  startedAt: 1_000,
  text: "",
  thinking: "",
  tools: [{ name: "grep", status: "running" }],
  timeline: [],
  toolUseCount: 10,
  usageTokens: 115_040,
  approxChars: 0,
  version: 0,
  ...over,
})

/** Render with fake timers and let the tree's seed poll fire. */
function renderWithTree(ui: React.ReactElement) {
  const result = render(ui)
  act(() => {
    jest.advanceTimersByTime(1)
  })
  return result
}

describe("BottomStatus", () => {
  it("renders nothing when idle with no activity, queue, or armed backtrack", () => {
    const { container } = render(<BottomStatus turnStatus="idle" />)
    expect(container.textContent).toBe("")
  })

  it("shows the working verb and the interrupt hint while streaming", () => {
    const { container } = render(<BottomStatus turnStatus="streaming" since={Date.now()} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Working")
    expect(text).toContain("esc to interrupt")
  })

  it("shows the stall hint when the stream has been silent past the threshold", () => {
    const { container } = render(
      <BottomStatus
        turnStatus="streaming"
        since={Date.now()}
        lastActivityAt={Date.now() - 11_000}
      />
    )
    expect(container.textContent ?? "").toContain("Waiting for API response")
  })

  it("hides the stall hint while deltas are still arriving", () => {
    const { container } = render(
      <BottomStatus turnStatus="streaming" since={Date.now()} lastActivityAt={Date.now()} />
    )
    expect(container.textContent ?? "").not.toContain("Waiting for API response")
  })

  it("does not show the stall hint when idle even if lastActivityAt is stale", () => {
    const { container } = render(
      <BottomStatus turnStatus="idle" lastActivityAt={Date.now() - 60_000} />
    )
    expect(container.textContent ?? "").not.toContain("Waiting for API response")
  })

  it("shows the stopping word while aborting", () => {
    const { container } = render(<BottomStatus turnStatus="aborting" />)
    expect(container.textContent ?? "").toContain("stopping")
  })

  it("shows a live tool detail line for a running tool", () => {
    const { container } = render(
      <BottomStatus
        turnStatus="streaming"
        since={Date.now()}
        tools={[tool({ toolName: "bash", input: { command: "npm test" } })]}
      />
    )
    expect(container.textContent ?? "").toContain("└ bash: npm test")
  })

  it("caps tool detail at three lines (most recent)", () => {
    const tools: ToolCell[] = [1, 2, 3, 4].map((n) =>
      tool({ id: `t${n}`, input: { command: `cmd${n}` } })
    )
    const { container } = render(
      <BottomStatus turnStatus="streaming" since={Date.now()} tools={tools} />
    )
    const text = container.textContent ?? ""
    expect(text).not.toContain("cmd1")
    expect(text).toContain("cmd4")
  })

  it("shows the visible steer queue and a btw count chip", () => {
    const { container } = render(
      <BottomStatus
        turnStatus="streaming"
        since={Date.now()}
        steerQueue={["also update the docs", "and run the linter"]}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("btw×2")
    expect(text).toContain("also update the docs")
  })

  it("shows the run-state chips (sub-agent, background, interrupted, copilot, verbose)", () => {
    const { container } = render(
      <BottomStatus
        turnStatus="streaming"
        since={Date.now()}
        verbose
        subagentRunning={{ name: "reviewer", count: 3 }}
        backgroundSubagents={2}
        interruptedBackgroundSubagents={1}
        copilot={{ name: "Nightly report" }}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("detail")
    expect(text).toContain("◆ reviewer×3")
    expect(text).toContain("⧗ 2 bg")
    expect(text).toContain("! 1 bg interrupted")
    expect(text).toContain("copilot: Nightly report")
    expect(text).toContain("/workflow exit")
  })

  it("shows a determinate activity pill with progress when max is known", () => {
    const { container } = render(
      <BottomStatus
        turnStatus="idle"
        activity={{ kind: "goal", label: "ship it", turns: 2, max: 5, status: "running" }}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("goal")
    expect(text).toContain("2/5")
    expect(text).toContain("esc to cancel")
  })

  it("shows the backtrack confirm hint when armed and idle", () => {
    const { container } = render(<BottomStatus turnStatus="idle" backtrackArmed />)
    expect(container.textContent ?? "").toContain("esc again to edit last message")
  })

  it("hides the backtrack hint while busy (esc interrupts instead)", () => {
    const { container } = render(
      <BottomStatus turnStatus="streaming" since={Date.now()} backtrackArmed />
    )
    const text = container.textContent ?? ""
    expect(text).not.toContain("esc again to edit")
    expect(text).toContain("esc to interrupt")
  })
})

describe("BottomStatus running-agents tree", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("renders the CC-style tree with per-agent stats + activity, suppressing the ◆ chip", () => {
    const { container } = renderWithTree(
      <BottomStatus
        turnStatus="streaming"
        since={Date.now()}
        sessionId="s1"
        subagentRunning={{ name: "reviewer", count: 2 }}
        getLiveEntries={() => [
          liveEntry(),
          liveEntry({
            liveId: "live-2",
            name: "Finder: Sidecar",
            toolUseCount: 1,
            usageTokens: 900,
          }),
        ]}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Running 2 agents…")
    expect(text).toContain("Finder: Rust backend")
    expect(text).toContain("10 tool uses · 115.0k tokens")
    expect(text).toContain("⎿ Searching for 1 pattern…")
    expect(text).toContain("Finder: Sidecar")
    expect(text).toContain("1 tool use · 900 tokens")
    // The coarse chip is redundant while the tree shows.
    expect(text).not.toContain("◆ reviewer×2")
  })

  it("lists only running entries and folds the overflow into a +N line", () => {
    const entries = Array.from({ length: 8 }, (_, i) =>
      liveEntry({ liveId: `l${i}`, name: `agent-${i}`, startedAt: i })
    )
    const { container } = renderWithTree(
      <BottomStatus
        turnStatus="streaming"
        since={Date.now()}
        sessionId="s1"
        getLiveEntries={() => [...entries, liveEntry({ liveId: "done", status: "done" })]}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Running 8 agents…")
    expect(text).toContain("agent-5")
    expect(text).not.toContain("agent-6")
    expect(text).toContain("2 more — ctrl+b")
  })

  it("keeps the layer mounted for the tree while idle and drops it when runs settle", () => {
    let entries = [liveEntry()]
    const { container } = renderWithTree(
      <BottomStatus turnStatus="idle" backgroundSubagents={1} getLiveEntries={() => entries} />
    )
    expect(container.textContent).toContain("Running 1 agent…")
    entries = []
    act(() => {
      jest.advanceTimersByTime(1000)
    })
    expect(container.textContent ?? "").not.toContain("Running 1 agent")
  })

  it("publishes the hit-test state to agentTreeRef and clears it when the tree hides", () => {
    const ref: React.MutableRefObject<AgentTreeHit | null> = { current: null }
    let entries = [liveEntry()]
    renderWithTree(
      <BottomStatus
        turnStatus="streaming"
        since={Date.now()}
        agentTreeRef={ref}
        getLiveEntries={() => entries}
      />
    )
    expect(ref.current?.agents).toEqual([
      { liveId: "live-1", name: "Finder: Rust backend", task: "find the rust bits" },
    ])
    entries = []
    act(() => {
      jest.advanceTimersByTime(1000)
    })
    expect(ref.current).toBeNull()
  })

  it("keeps the fallback ◆ chip when the live store has no entries", () => {
    const { container } = renderWithTree(
      <BottomStatus
        turnStatus="streaming"
        since={Date.now()}
        subagentRunning={{ name: "reviewer", count: 2 }}
        getLiveEntries={() => []}
      />
    )
    expect(container.textContent ?? "").toContain("◆ reviewer×2")
  })
})

describe("agentTreeRowTarget", () => {
  it("maps the header, agent rows (2 lines each), the overflow line, and out-of-range", () => {
    expect(agentTreeRowTarget(-1, 2)).toBeNull()
    expect(agentTreeRowTarget(0, 2)).toBe("header")
    expect(agentTreeRowTarget(1, 2)).toBe(0)
    expect(agentTreeRowTarget(2, 2)).toBe(0)
    expect(agentTreeRowTarget(3, 2)).toBe(1)
    expect(agentTreeRowTarget(4, 2)).toBe(1)
    expect(agentTreeRowTarget(5, 2)).toBe("more")
  })
})
