/**
 * @jest-environment jsdom
 */

import * as ReactForMock from "react"
import { fireEvent, render } from "@testing-library/react"

import {
  ToolActivityGroup,
  type ToolActivityChildOptions,
  type ToolActivityGroupEntry,
} from "./tool-activity-group"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

// Default to the reduced-motion branch so the body renders synchronously
// without AnimatePresence wrappers — deterministic. Individual tests can flip
// `mockMotion.reduce` to exercise the animated path.
const mockMotion = { reduce: true, durationScale: 1 }
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => mockMotion,
  ReadingCollapse: ({ open, children }: { open: boolean; children: unknown }) =>
    open ? ReactForMock.createElement("div", null, children as never) : null,
  MotionStatusSwap: ({ children }: { children: unknown }) =>
    ReactForMock.createElement(ReactForMock.Fragment, null, children as never),
}))

afterEach(() => {
  mockMotion.reduce = true
})

let keySeq = 0
function entry(type: string, state = "output-available"): ToolActivityGroupEntry {
  return { part: { type, state } as never, key: `${type}-${keySeq++}` }
}

/**
 * Stand-in for a caller-rendered child using the controlled disclosure contract.
 */
function renderRow(part: { type: string }, key: string, opts: ToolActivityChildOptions) {
  return ReactForMock.createElement(
    "button",
    {
      key,
      "data-testid": `row-${part.type}`,
      "data-expanded": String(opts.expanded),
      onClick: opts.onToggle,
    },
    part.type
  )
}

/** Distinct part types handed to `renderChild`, in first-seen order. */
function renderedTypes(spy: jest.Mock): string[] {
  const seen: string[] = []
  for (const [part] of spy.mock.calls as Array<[{ type: string }]>) {
    if (!seen.includes(part.type)) seen.push(part.type)
  }
  return seen
}

const ROWS = [entry("tool-Read"), entry("tool-Grep"), entry("tool-Bash")]

describe("ToolActivityGroup", () => {
  it("does not construct hidden tool cards, and restores every child on expansion", () => {
    const renderChild = jest.fn(renderRow)
    const entries = Array.from({ length: 2000 }, () => entry("tool-Read"))
    const { getByTestId, rerender } = render(
      <ToolActivityGroup entries={entries} mode="simplified" renderChild={renderChild} />
    )
    rerender(
      <ToolActivityGroup entries={[...entries]} mode="simplified" renderChild={renderChild} />
    )
    expect(renderChild).not.toHaveBeenCalled()
    fireEvent.click(getByTestId("tool-activity-group-toggle"))
    expect(renderChild).toHaveBeenCalledTimes(2000)
    fireEvent.click(getByTestId("tool-activity-group-toggle"))
    renderChild.mockClear()
    rerender(
      <ToolActivityGroup entries={[...entries]} mode="simplified" renderChild={renderChild} />
    )
    expect(renderChild).not.toHaveBeenCalled()
  })
  it("summarizes the count and aggregate status", () => {
    const { getByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="standard" renderChild={renderRow} />
    )
    const group = getByTestId("tool-activity-group")
    expect(group.getAttribute("data-status")).toBe("complete")
    expect(group.textContent).toContain("group.summary")
  })

  it("renders the shared count summary in the header (all modes)", () => {
    const entries = [entry("tool-Read"), entry("tool-Read"), entry("tool-Grep")]
    for (const mode of ["standard", "simplified", "detailed"] as const) {
      const { getByTestId, unmount } = render(
        <ToolActivityGroup entries={entries} mode={mode} renderChild={renderRow} />
      )
      const tally = getByTestId("tool-activity-group-tally")
      // Mocked t echoes `<key>:{params}` — the row shows the tool-call count
      // label plus every bucket of the TUI-style count summary.
      expect(tally.textContent).toContain('group.summary:{"count":3}')
      expect(tally.textContent).toContain('count.read:{"count":2}')
      expect(tally.textContent).toContain('count.search:{"count":1}')
      unmount()
    }
  })

  it("stays open in simplified mode while a child is still running", () => {
    const entries = [entry("tool-Read"), entry("tool-Grep", "input-available")]
    const { getByTestId } = render(
      <ToolActivityGroup entries={entries} mode="simplified" renderChild={renderRow} />
    )
    // Running → auto-open, so the rows render without a manual toggle.
    expect(getByTestId("row-tool-Read")).toBeTruthy()
  })

  it("stays open and shows an N-failed badge when a child errored (simplified)", () => {
    const entries = [entry("tool-Read", "output-error"), entry("tool-Grep")]
    const { getByTestId } = render(
      <ToolActivityGroup entries={entries} mode="simplified" renderChild={renderRow} />
    )
    expect(getByTestId("row-tool-Read")).toBeTruthy() // auto-open on error
    expect(getByTestId("tool-activity-group-failed").textContent).toContain('{"count":1}')
  })

  it("a manual toggle overrides the running auto-open (collapses live)", () => {
    const entries = [entry("tool-Read"), entry("tool-Grep", "input-available")]
    const { getByTestId, queryByTestId } = render(
      <ToolActivityGroup entries={entries} mode="simplified" renderChild={renderRow} />
    )
    expect(getByTestId("row-tool-Read")).toBeTruthy()
    fireEvent.click(getByTestId("tool-activity-group-toggle"))
    expect(queryByTestId("row-tool-Read")).toBeNull()
  })

  it("shows the N-failed badge in standard mode too", () => {
    const entries = [entry("tool-Read", "output-error"), entry("tool-Grep", "output-error")]
    const { getByTestId } = render(
      <ToolActivityGroup entries={entries} mode="standard" renderChild={renderRow} />
    )
    expect(getByTestId("tool-activity-group-failed").textContent).toContain('{"count":2}')
  })

  it("marks running aggregate status", () => {
    const entries = [entry("tool-Read"), entry("tool-Grep", "input-available")]
    const { getByTestId } = render(
      <ToolActivityGroup entries={entries} mode="standard" renderChild={renderRow} />
    )
    expect(getByTestId("tool-activity-group").getAttribute("data-status")).toBe("running")
  })

  it("simplified mode is collapsed by default and toggles open", () => {
    const { getByTestId, queryByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="simplified" renderChild={renderRow} />
    )
    expect(queryByTestId("row-tool-Read")).toBeNull()
    fireEvent.click(getByTestId("tool-activity-group-toggle"))
    expect(getByTestId("row-tool-Read")).toBeTruthy()
  })

  it("standard mode is expanded by default and renders every child", () => {
    const renderChild = jest.fn(renderRow)
    const { getByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="standard" renderChild={renderChild} />
    )
    expect(getByTestId("row-tool-Read")).toBeTruthy()
    expect(renderedTypes(renderChild)).toEqual(["tool-Read", "tool-Grep", "tool-Bash"])
  })

  // The group must never render children itself: the caller owns what a child
  // looks like (a compact row, a full card + its plugin action slot), and the
  // simplified path used to bypass it — silently dropping the per-call plugin
  // slot for every tool inside a group.
  it("routes children through renderChild in simplified mode too", () => {
    const renderChild = jest.fn(renderRow)
    const { getByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="simplified" renderChild={renderChild} />
    )
    fireEvent.click(getByTestId("tool-activity-group-toggle")) // open group
    expect(renderedTypes(renderChild)).toEqual(["tool-Read", "tool-Grep", "tool-Bash"])
    expect(getByTestId("row-tool-Bash")).toBeTruthy()
  })

  it("toggles a single row's expanded state in simplified mode", () => {
    const { getByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="simplified" renderChild={renderRow} />
    )
    fireEvent.click(getByTestId("tool-activity-group-toggle")) // open group
    expect(getByTestId("row-tool-Read").getAttribute("data-expanded")).toBe("false")
    fireEvent.click(getByTestId("row-tool-Read"))
    expect(getByTestId("row-tool-Read").getAttribute("data-expanded")).toBe("true")
    fireEvent.click(getByTestId("row-tool-Read"))
    expect(getByTestId("row-tool-Read").getAttribute("data-expanded")).toBe("false")
  })

  it("expand-all toggles every row open in simplified mode", () => {
    const { getByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="simplified" renderChild={renderRow} />
    )
    fireEvent.click(getByTestId("tool-activity-group-toggle")) // open group
    fireEvent.click(getByTestId("tool-activity-group-expand-all"))
    expect(getByTestId("row-tool-Read").getAttribute("data-expanded")).toBe("true")
    expect(getByTestId("row-tool-Bash").getAttribute("data-expanded")).toBe("true")
  })

  it.each(["standard", "detailed"] as const)(
    "tracks bulk and individual state without remounting in %s",
    (mode) => {
      const { getByTestId } = render(
        <ToolActivityGroup entries={ROWS} mode={mode} renderChild={renderRow} />
      )
      const row = getByTestId("row-tool-Read")
      const bulk = getByTestId("tool-activity-group-expand-all")
      expect(bulk.textContent).toBe(mode === "detailed" ? "group.collapseAll" : "group.expandAll")
      row.focus()
      fireEvent.click(bulk)
      expect(getByTestId("row-tool-Read")).toBe(row)
      expect(document.activeElement).toBe(row)
      expect(row.getAttribute("data-expanded")).toBe(String(mode !== "detailed"))
      fireEvent.click(row)
      expect(bulk.textContent).toBe("group.expandAll")
      fireEvent.click(bulk)
      expect(row.getAttribute("data-expanded")).toBe("true")
      expect(bulk.textContent).toBe("group.collapseAll")
    }
  )

  it("keeps expansion by identity on reorder, clipping and same-position replacement", () => {
    const a = entry("tool-Read"),
      b = entry("tool-Grep"),
      c = entry("tool-Bash")
    const { getByTestId, rerender } = render(
      <ToolActivityGroup entries={[a, b]} mode="standard" renderChild={renderRow} />
    )
    fireEvent.click(getByTestId("row-tool-Read"))
    rerender(<ToolActivityGroup entries={[b, a]} mode="standard" renderChild={renderRow} />)
    expect(getByTestId("row-tool-Read").getAttribute("data-expanded")).toBe("true")
    expect(getByTestId("row-tool-Grep").getAttribute("data-expanded")).toBe("false")
    rerender(<ToolActivityGroup entries={[a, c]} mode="standard" renderChild={renderRow} />)
    expect(getByTestId("row-tool-Read").getAttribute("data-expanded")).toBe("true")
    expect(getByTestId("row-tool-Bash").getAttribute("data-expanded")).toBe("false")
    const replacement = entry("tool-Read")
    rerender(
      <ToolActivityGroup entries={[replacement, c]} mode="standard" renderChild={renderRow} />
    )
    expect(getByTestId("row-tool-Read").getAttribute("data-expanded")).toBe("false")
    rerender(<ToolActivityGroup entries={[a, c]} mode="standard" renderChild={renderRow} />)
    expect(getByTestId("row-tool-Read").getAttribute("data-expanded")).toBe("false")
  })

  it("preserves manual row choices across group collapse and mode changes", () => {
    const { getByTestId, rerender } = render(
      <ToolActivityGroup entries={ROWS} mode="detailed" renderChild={renderRow} />
    )
    fireEvent.click(getByTestId("row-tool-Read"))
    fireEvent.click(getByTestId("tool-activity-group-toggle"))
    fireEvent.click(getByTestId("tool-activity-group-toggle"))
    expect(getByTestId("row-tool-Read").getAttribute("data-expanded")).toBe("false")
    expect(getByTestId("row-tool-Grep").getAttribute("data-expanded")).toBe("true")
    rerender(<ToolActivityGroup entries={ROWS} mode="standard" renderChild={renderRow} />)
    expect(getByTestId("row-tool-Read").getAttribute("data-expanded")).toBe("false")
    expect(getByTestId("row-tool-Grep").getAttribute("data-expanded")).toBe("false")
    rerender(<ToolActivityGroup entries={ROWS} mode="detailed" renderChild={renderRow} />)
    expect(getByTestId("row-tool-Read").getAttribute("data-expanded")).toBe("false")
    expect(getByTestId("row-tool-Grep").getAttribute("data-expanded")).toBe("true")
  })

  it.each(["row", "bulk"])(
    "pins a live group after a %s interaction when calls complete",
    (action) => {
      const a = entry("tool-Read", "input-available"),
        b = entry("tool-Grep")
      const { getByTestId, rerender } = render(
        <ToolActivityGroup entries={[a, b]} mode="simplified" renderChild={renderRow} />
      )
      fireEvent.click(
        getByTestId(action === "row" ? "row-tool-Read" : "tool-activity-group-expand-all")
      )
      rerender(
        <ToolActivityGroup
          entries={[{ ...a, part: { ...a.part, state: "output-available" } as never }, b]}
          mode="simplified"
          renderChild={renderRow}
        />
      )
      expect(getByTestId("tool-activity-group-toggle").getAttribute("aria-expanded")).toBe("true")
      expect(getByTestId("row-tool-Read").getAttribute("data-expanded")).toBe("true")
    }
  )

  it.each(["input-streaming", "output-denied", "approval-requested"])(
    "keeps %s visible in simplified mode",
    (state) => {
      const { getByTestId } = render(
        <ToolActivityGroup
          entries={[entry("tool-Read", state), entry("tool-Grep")]}
          mode="simplified"
          renderChild={renderRow}
        />
      )
      expect(getByTestId("tool-activity-group-toggle").getAttribute("aria-expanded")).toBe("true")
      expect(getByTestId("tool-activity-group").getAttribute("data-status")).not.toBe("complete")
    }
  )

  it("honors explicit expanded preferences and stable handlers across stream updates", () => {
    const entries = ROWS.map((e) => ({ ...e, defaultOpen: true }))
    const renderChild = jest.fn(renderRow)
    const { getByTestId, rerender } = render(
      <ToolActivityGroup
        entries={entries}
        mode="simplified"
        defaultOpen
        renderChild={renderChild}
      />
    )
    const first = renderChild.mock.calls[0][2].onToggle
    expect(getByTestId("row-tool-Read").getAttribute("data-expanded")).toBe("true")
    renderChild.mockClear()
    rerender(
      <ToolActivityGroup
        entries={[...entries]}
        mode="simplified"
        defaultOpen
        renderChild={renderChild}
      />
    )
    expect(renderChild.mock.calls[0][2].onToggle).toBe(first)
  })

  it("renders the animated (AnimatePresence) body when motion is enabled", () => {
    mockMotion.reduce = false
    const { getByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="standard" renderChild={renderRow} />
    )
    expect(getByTestId("row-tool-Read")).toBeTruthy()
  })

  it("collapsing the group hides its body", () => {
    const { getByTestId, queryByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="standard" renderChild={renderRow} />
    )
    expect(getByTestId("row-tool-Read")).toBeTruthy()
    fireEvent.click(getByTestId("tool-activity-group-toggle"))
    expect(queryByTestId("row-tool-Read")).toBeNull()
  })
})
