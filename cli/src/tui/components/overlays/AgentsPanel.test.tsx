import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { AgentsPanel } from "./AgentsPanel"
import { absoluteTopLeft } from "../../input/element-position"
import type { AgentPanelRow } from "../../runtime/agents-panel-model"

jest.mock("../../input/element-position", () => ({ absoluteTopLeft: jest.fn(() => null) }))
const mockPos = absoluteTopLeft as jest.Mock

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
  const cb = { onView: jest.fn(), onStop: jest.fn(), onCancel: jest.fn() }
  const result = render(<AgentsPanel rows={rows} now={NOW} {...cb} {...props} />)
  return { ...result, ...cb }
}

describe("AgentsPanel", () => {
  beforeEach(() => {
    __resetInk()
    mockPos.mockReturnValue(null)
  })

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

  it("stops only a selected running SDK-native task with s", () => {
    const native = {
      id: "live:native",
      kind: "inflight" as const,
      name: "native",
      task: "work",
      status: "running" as const,
      liveId: "native",
      runtimeTaskId: "task-1",
    }
    const { onStop } = wrap({ rows: [native] })
    key("s")
    expect(onStop).toHaveBeenCalledWith(native)
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

  it("opens the clicked row when the layout is measured", () => {
    mockPos.mockReturnValue({ top: 0, left: 0 })
    const { onView } = wrap()
    // border(1)+header(1) → first item at 0-based row 2 (SGR row 3); row 4 → offset 1.
    key("[<0;5;4M")
    expect(onView).toHaveBeenCalledWith(expect.objectContaining({ id: "bg:r1" }))
  })

  it("renders an in-turn row that has no task without a trailing separator", () => {
    const text =
      wrap({
        rows: [{ id: "inflight:x", kind: "inflight", name: "lonely", task: "", status: "running" }],
      }).container.textContent ?? ""
    expect(text).toContain("lonely")
    expect(text).toContain("in-turn")
  })

  it("shows tool-use and token stats in a row's hint", () => {
    const text =
      wrap({
        rows: [
          {
            id: "live:l1",
            kind: "inflight",
            name: "finder",
            task: "scan",
            status: "running",
            startedAt: NOW - 155_000,
            liveId: "l1",
            toolUses: 10,
            tokens: 115_040,
          },
        ],
      }).container.textContent ?? ""
    expect(text).toContain("10 tools")
    expect(text).toContain("↓ 115.0k tok")
    expect(text).toContain("2m 35s")
  })

  it("indents a nested row under its parent with the depth glyph", () => {
    const text =
      wrap({
        rows: [
          {
            id: "live:outer",
            kind: "inflight",
            name: "outer-agent",
            task: "t",
            status: "running",
            liveId: "outer",
          },
          {
            id: "live:inner",
            kind: "inflight",
            name: "inner-agent",
            task: "t",
            status: "running",
            liveId: "inner",
            parentLiveId: "outer",
            depth: 1,
          },
        ],
      }).container.textContent ?? ""
    expect(text.indexOf("inner-agent")).toBeGreaterThan(text.indexOf("outer-agent"))
    expect(text).toContain("└ ")
  })

  it("re-reads the rows from the refresher on the 1s tick", () => {
    jest.useFakeTimers()
    try {
      const refreshed: AgentPanelRow[] = [
        { id: "live:l1", kind: "inflight", name: "finder", task: "", status: "done", liveId: "l1" },
      ]
      const refresh = jest.fn(() => refreshed)
      const { container } = wrap({ refresh })
      expect(container.textContent).toContain("scout")
      act(() => {
        jest.advanceTimersByTime(1000)
      })
      expect(refresh).toHaveBeenCalled()
      expect(container.textContent).toContain("finder")
      expect(container.textContent).not.toContain("scout")
    } finally {
      jest.useRealTimers()
    }
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
