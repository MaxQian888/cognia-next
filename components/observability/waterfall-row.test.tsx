/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { WaterfallList, WaterfallRow } from "./waterfall-row"
import type { WaterfallNode } from "@/lib/observability/trace-rollup"
import { makeSpan } from "@/lib/observability/fixtures"

jest.mock("next-intl", () => {
  // Key-echo translator (with `has`, which the enum-label hook asks before
  // translating) plus an Intl-backed formatter — what next-intl's
  // `useFormatter` does, in "en"/UTC (next-intl itself is ESM-only and cannot
  // be `requireActual`-ed here) — so units and currency render as in the app.
  const translator = () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key
  return {
    useTranslations: () => Object.assign(translator(), { has: () => false }),
    useFormatter: () => ({
      number: (value: number, options?: Intl.NumberFormatOptions) =>
        new Intl.NumberFormat("en", options).format(value),
      dateTime: (value: number | Date, options?: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en", { timeZone: "UTC", ...options }).format(value),
    }),
  }
})

function node(over: Partial<WaterfallNode> = {}): WaterfallNode {
  return {
    span: makeSpan({ spanId: "s1", operationName: "chat", responseModel: "opus" }),
    label: "chat",
    depth: 0,
    offsetMs: 0,
    widthMs: 100,
    isError: false,
    children: [],
    ...over,
  }
}

const noop = () => {}

describe("WaterfallRow", () => {
  it("positions the timing bar by offset and width", () => {
    render(
      <WaterfallRow
        node={node({ offsetMs: 50, widthMs: 100 })}
        totalMs={200}
        color="#abc"
        onSelect={noop}
      />
    )
    const bar = screen.getByTestId("waterfall-bar-s1")
    expect(bar).toHaveStyle({ left: "25%", width: "50%" })
  })

  it("clamps width to a minimum so tiny spans stay visible", () => {
    render(
      <WaterfallRow
        node={node({ offsetMs: 0, widthMs: 0 })}
        totalMs={1000}
        color="#abc"
        onSelect={noop}
      />
    )
    expect(screen.getByTestId("waterfall-bar-s1")).toHaveStyle({ width: "0.5%" })
  })

  it("names a failed span's icon instead of relying on colour", () => {
    render(
      <WaterfallRow node={node({ isError: true })} totalMs={100} color="#f00" onSelect={noop} />
    )
    expect(screen.getByRole("img", { name: "failed" })).toBeInTheDocument()
  })

  it("expands events when toggled, with app-locale offsets", () => {
    const withEvents = node({
      span: makeSpan({
        spanId: "s2",
        startTime: 1000,
        events: [{ name: "tool_use", at: 1050 }],
      }),
    })
    render(<WaterfallRow node={withEvents} totalMs={100} color="#abc" onSelect={noop} />)
    expect(screen.queryByTestId("waterfall-meta-s2")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("waterfall-toggle-s2"))
    const meta = screen.getByTestId("waterfall-meta-s2")
    expect(meta).toHaveTextContent("tool_use")
    expect(meta).toHaveTextContent('eventOffset:{"offset":"50ms"}')
    expect(screen.getByTestId("waterfall-toggle-s2")).toHaveAttribute("aria-expanded", "true")
  })

  it("selects the span on click", () => {
    const onSelect = jest.fn()
    render(<WaterfallRow node={node()} totalMs={100} color="#fff" selected onSelect={onSelect} />)
    const button = screen.getByTestId("waterfall-select-s1")
    expect(button).toHaveAttribute("aria-current", "true")
    fireEvent.click(button)
    expect(onSelect).toHaveBeenCalledWith("s1")
  })

  it("never nests a control inside another control", () => {
    render(
      <WaterfallRow
        node={node({ span: { ...node().span, events: [{ name: "tool_call", at: 5 }] } })}
        totalMs={100}
        color="#fff"
        onSelect={noop}
      />
    )
    const select = screen.getByTestId("waterfall-select-s1")
    const toggle = screen.getByTestId("waterfall-toggle-s1")
    expect(select.contains(toggle)).toBe(false)
    expect(toggle.contains(select)).toBe(false)
    expect(select.querySelector("button, [role='button']")).toBeNull()
  })

  it("does not select the span when the events toggle is clicked", () => {
    const onSelect = jest.fn()
    render(
      <WaterfallRow
        node={node({ span: { ...node().span, events: [{ name: "tool_call", at: 5 }] } })}
        totalMs={100}
        color="#fff"
        onSelect={onSelect}
      />
    )
    fireEvent.click(screen.getByTestId("waterfall-toggle-s1"))
    expect(screen.getByTestId("waterfall-meta-s1")).toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("expands and collapses events with → / ← on the row", () => {
    render(
      <WaterfallRow
        node={node({ span: { ...node().span, events: [{ name: "tool_call", at: 5 }] } })}
        totalMs={100}
        color="#fff"
        onSelect={noop}
      />
    )
    const select = screen.getByTestId("waterfall-select-s1")
    fireEvent.keyDown(select, { key: "ArrowRight" })
    expect(screen.getByTestId("waterfall-meta-s1")).toBeInTheDocument()
    expect(select).toHaveAttribute("aria-expanded", "true")
    fireEvent.keyDown(select, { key: "ArrowLeft" })
    expect(screen.queryByTestId("waterfall-meta-s1")).not.toBeInTheDocument()
  })

  it("renders no toggle when there are no events", () => {
    render(
      <WaterfallRow
        node={node({ span: makeSpan({ spanId: "s3" }) })}
        totalMs={100}
        color="#abc"
        onSelect={noop}
      />
    )
    expect(screen.queryByTestId("waterfall-toggle-s3")).not.toBeInTheDocument()
    expect(screen.getByTestId("waterfall-select-s3")).not.toHaveAttribute("aria-expanded")
  })
})

describe("WaterfallList", () => {
  const rows = ["a", "b", "c"].map((id, index) =>
    node({ span: makeSpan({ spanId: id }), label: id, offsetMs: index * 10 })
  )

  function renderList(selectedSpanId: string | null = null, onSelect = jest.fn()) {
    render(
      <WaterfallList
        rows={rows}
        totalMs={100}
        colorFor={() => "#abc"}
        selectedSpanId={selectedSpanId}
        onSelect={onSelect}
        label="Spans"
      />
    )
    return onSelect
  }

  const tabStops = () =>
    ["a", "b", "c"].filter(
      (id) => screen.getByTestId(`waterfall-select-${id}`).getAttribute("tabindex") === "0"
    )

  it("exposes exactly one tab stop — the selected row", () => {
    renderList("b")
    expect(screen.getByRole("list", { name: "Spans" })).toBeInTheDocument()
    expect(tabStops()).toEqual(["b"])
  })

  it("falls back to the first row with no selection", () => {
    renderList()
    expect(tabStops()).toEqual(["a"])
  })

  it("moves focus and the tab stop with ↑/↓/Home/End", () => {
    renderList()
    const first = screen.getByTestId("waterfall-select-a")
    first.focus()
    fireEvent.keyDown(first, { key: "ArrowDown" })
    expect(screen.getByTestId("waterfall-select-b")).toHaveFocus()
    expect(tabStops()).toEqual(["b"])
    fireEvent.keyDown(screen.getByTestId("waterfall-select-b"), { key: "End" })
    expect(screen.getByTestId("waterfall-select-c")).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId("waterfall-select-c"), { key: "ArrowDown" })
    expect(screen.getByTestId("waterfall-select-c")).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId("waterfall-select-c"), { key: "Home" })
    expect(screen.getByTestId("waterfall-select-a")).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId("waterfall-select-a"), { key: "ArrowUp" })
    expect(screen.getByTestId("waterfall-select-a")).toHaveFocus()
  })

  it("selects through the row button", () => {
    const onSelect = renderList()
    fireEvent.click(screen.getByTestId("waterfall-select-c"))
    expect(onSelect).toHaveBeenCalledWith("c")
  })
})
