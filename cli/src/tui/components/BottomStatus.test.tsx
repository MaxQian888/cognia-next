import React from "react"
import { render } from "@testing-library/react"

import { BottomStatus } from "./BottomStatus"
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
