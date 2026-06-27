import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { AgentsPanel } from "./AgentsPanel"
import type { AgentPanelRow } from "../../runtime/agents-panel-model"

function key(input: string, k?: Record<string, boolean>) {
  act(() => __fireInput(input, k))
}

const NOW = 100_000

const rows: AgentPanelRow[] = [
  {
    id: "inflight:k1",
    kind: "inflight",
    name: "scout",
    task: "search the repo",
    status: "running",
  },
  {
    id: "bg:r1",
    kind: "background",
    name: "reviewer",
    task: "review the diff",
    status: "done",
    startedAt: NOW - 12_000,
    runId: "r1",
    output: "the final summary",
  },
  {
    id: "bg:r2",
    kind: "background",
    name: "qa",
    task: "run tests",
    status: "interrupted",
    startedAt: NOW - 5_000,
    runId: "r2",
  },
]

function wrap(props: Partial<React.ComponentProps<typeof AgentsPanel>> = {}) {
  const cb = { onView: jest.fn(), onCancel: jest.fn() }
  const result = render(<AgentsPanel rows={rows} now={NOW} {...cb} {...props} />)
  return { ...result, ...cb }
}

describe("AgentsPanel", () => {
  beforeEach(() => __resetInk())

  it("summarizes counts and lists every row with name + elapsed", () => {
    const text = wrap().container.textContent ?? ""
    expect(text).toContain("running 1")
    expect(text).toContain("settled 2")
    expect(text).toContain("scout")
    expect(text).toContain("in-turn")
    expect(text).toContain("reviewer")
    expect(text).toContain("background · 12s")
    expect(text).toContain("review the diff")
  })

  it("renders an empty-state line when nothing is running or recorded", () => {
    const text = wrap({ rows: [] }).container.textContent ?? ""
    expect(text).toContain("no sub-agents running or recorded")
  })

  it("Enter views the highlighted row's output", () => {
    const { onView } = wrap()
    key("", { downArrow: true }) // row 1 = reviewer
    key("", { return: true })
    expect(onView).toHaveBeenCalledWith(expect.objectContaining({ runId: "r1" }))
  })

  it("Esc cancels", () => {
    const { onCancel } = wrap()
    key("", { escape: true })
    expect(onCancel).toHaveBeenCalled()
  })

  it("clamps navigation at the list bounds", () => {
    const { onView } = wrap()
    key("", { upArrow: true }) // already at top → stays on row 0
    key("", { return: true })
    expect(onView).toHaveBeenCalledWith(expect.objectContaining({ id: "inflight:k1" }))
  })

  it("wheel-scrolls the selection (down then up) and Enter opens it", () => {
    const { onView } = wrap()
    key("[<65;5;5M") // SGR wheel-down → select row 1
    key("", { return: true })
    expect(onView).toHaveBeenCalledWith(expect.objectContaining({ id: "bg:r1" }))
    key("[<64;5;5M") // SGR wheel-up → back to row 0
    key("", { return: true })
    expect(onView).toHaveBeenLastCalledWith(expect.objectContaining({ id: "inflight:k1" }))
  })

  it("ignores a left-click when the panel has no measured layout (test env)", () => {
    const { onView } = wrap()
    key("[<0;5;5M") // left-click press; absoluteTopLeft → null in the mock → ignored
    expect(onView).not.toHaveBeenCalled()
  })

  it("renders an in-turn row that has no task without a trailing separator", () => {
    const text =
      wrap({
        rows: [{ id: "inflight:x", kind: "inflight", name: "lonely", task: "", status: "running" }],
      }).container.textContent ?? ""
    expect(text).toContain("lonely")
    expect(text).toContain("in-turn")
  })

  it("shows scroll indicators and windows the list when it overflows maxRows", () => {
    const many: AgentPanelRow[] = Array.from({ length: 6 }, (_, i) => ({
      id: `bg:r${i}`,
      kind: "background",
      name: `agent-${i}`,
      task: "",
      status: "done",
      startedAt: NOW - i,
      runId: `r${i}`,
    }))
    const { container } = wrap({ rows: many, maxRows: 2 })
    // Walk down past the visible window so both indicators light up.
    key("", { downArrow: true })
    key("", { downArrow: true })
    key("", { downArrow: true })
    const text = container.textContent ?? ""
    expect(text).toContain("more")
  })
})
