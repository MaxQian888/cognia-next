import React from "react"
import { render } from "@testing-library/react"

const mockStaticRenders: number[] = []

jest.mock("ink", () => {
  const actual = jest.requireActual("ink")
  return {
    ...actual,
    Static: ({
      items,
      children,
    }: {
      items: unknown[]
      children: (item: unknown) => React.ReactNode
    }) => {
      mockStaticRenders.push(items.length)
      return <>{items.map((item) => children(item))}</>
    },
  }
})

import { limitReplayCells, Transcript } from "./Transcript"
import type { Cell } from "../state/types"

describe("Transcript", () => {
  beforeEach(() => {
    mockStaticRenders.length = 0
  })

  it("renders every cell in order", () => {
    const cells: Cell[] = [
      { id: "1", kind: "user", text: "question" },
      { id: "2", kind: "assistant", raw: "answer" },
    ]
    const { container } = render(<Transcript cells={cells} />)
    const text = container.textContent ?? ""
    expect(text).toContain("question")
    expect(text).toContain("answer")
  })

  it("renders nothing for an empty transcript", () => {
    const { container } = render(<Transcript cells={[]} />)
    expect(container.textContent).toBe("")
  })

  it("emits the header as the first row when provided", () => {
    const cells: Cell[] = [{ id: "1", kind: "user", text: "hello" }]
    const { container } = render(<Transcript cells={cells} header={<span>BANNER</span>} />)
    const text = container.textContent ?? ""
    expect(text).toContain("BANNER")
    expect(text).toContain("hello")
    expect(text.indexOf("BANNER")).toBeLessThan(text.indexOf("hello"))
  })

  it("renders the header even with an empty transcript", () => {
    const { container } = render(<Transcript cells={[]} header={<span>BANNER</span>} />)
    expect(container.textContent).toContain("BANNER")
  })

  it("skips rebuilding stable static transcript rows", () => {
    const cells: Cell[] = [{ id: "1", kind: "user", text: "hello" }]
    const header = <span>BANNER</span>
    const { rerender } = render(<Transcript cells={cells} header={header} />)
    expect(mockStaticRenders).toEqual([2])
    mockStaticRenders.length = 0
    rerender(<Transcript cells={cells} header={header} />)
    expect(mockStaticRenders).toEqual([])
  })

  it("renders cells in live mode without the header (fullscreen viewport)", () => {
    const cells: Cell[] = [
      { id: "1", kind: "user", text: "question" },
      { id: "2", kind: "assistant", raw: "answer" },
    ]
    const { container } = render(
      <Transcript cells={cells} header={<span>BANNER</span>} mode="live" />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("question")
    expect(text).toContain("answer")
    // Live mode owns no header — the fullscreen banner is fixed separately.
    expect(text).not.toContain("BANNER")
  })

  it("still honors verbose in live mode", () => {
    const cells: Cell[] = [
      {
        id: "t1",
        kind: "tool",
        callKey: "k",
        toolName: "read",
        input: { path: "f" },
        status: "done",
        result: "LIVE_SECRET_BODY",
        collapsed: true,
      },
    ]
    const collapsed = render(<Transcript cells={cells} mode="live" />)
    expect(collapsed.container.textContent ?? "").not.toContain("LIVE_SECRET_BODY")
    const verbose = render(<Transcript cells={cells} mode="live" verbose />)
    expect(verbose.container.textContent ?? "").toContain("LIVE_SECRET_BODY")
  })

  it("folds a burst of completed context tools into one summary row in live mode", () => {
    const ctx = (id: string, toolName: string): Cell => ({
      id,
      kind: "tool",
      callKey: id,
      toolName,
      input: {},
      status: "done",
      result: "x",
      collapsed: true,
    })
    const cells: Cell[] = [ctx("1", "read"), ctx("2", "grep"), ctx("3", "read")]
    const { container } = render(<Transcript cells={cells} mode="live" />)
    const text = container.textContent ?? ""
    // One summary line instead of three cards.
    expect(text).toContain("⚙ 2 reads, 1 search")
    // Verbose keeps them individual (no fold).
    const verbose = render(<Transcript cells={cells} mode="live" verbose />)
    expect(verbose.container.textContent ?? "").not.toContain("⚙")
  })

  it("reports every cell height and unfolds context runs while measuring (find active)", () => {
    const ctx = (id: string, toolName: string): Cell => ({
      id,
      kind: "tool",
      callKey: id,
      toolName,
      input: {},
      status: "done",
      result: "x",
      collapsed: true,
    })
    const cells: Cell[] = [ctx("1", "read"), ctx("2", "grep"), ctx("3", "read")]
    const onCellHeight = jest.fn()
    const { container } = render(
      <Transcript cells={cells} mode="live" measuring onCellHeight={onCellHeight} />
    )
    // Measuring disables the context fold so each cell stays addressable.
    expect(container.textContent ?? "").not.toContain("⚙")
    // Every cell reports a height for the cursor's row map.
    expect(onCellHeight.mock.calls.map((c) => c[0]).sort()).toEqual(["1", "2", "3"])
  })

  it("renders the focused cell (accent-border branch) without dropping content", () => {
    const cells: Cell[] = [
      { id: "u1", kind: "user", text: "alpha" },
      { id: "u2", kind: "user", text: "beta" },
    ]
    // Exercises the focused-cell wrapper branch; both cells still render.
    const { container } = render(<Transcript cells={cells} mode="live" focusedCellId="u2" />)
    const text = container.textContent ?? ""
    expect(text).toContain("alpha")
    expect(text).toContain("beta")
  })

  it("hides a collapsed tool result by default but reveals it in verbose mode", () => {
    const cells: Cell[] = [
      {
        id: "t1",
        kind: "tool",
        callKey: "k",
        toolName: "read",
        input: { path: "f" },
        status: "done",
        result: "SECRET_FILE_BODY",
        collapsed: true,
      },
    ]
    const collapsed = render(<Transcript cells={cells} />)
    expect(collapsed.container.textContent ?? "").not.toContain("SECRET_FILE_BODY")
    const verbose = render(<Transcript cells={cells} verbose />)
    expect(verbose.container.textContent ?? "").toContain("SECRET_FILE_BODY")
  })

  it("limits repaint replay by rendered rows while keeping complete newest cells", () => {
    const cells: Cell[] = Array.from({ length: 6 }, (_, index) => ({
      id: String(index),
      kind: "user" as const,
      text: `row-${index}`,
    }))
    const limited = limitReplayCells(cells, 6, 80, false)
    expect(limited.map((cell) => cell.id)).toEqual(["4", "5"])
    expect(limitReplayCells(cells, 0, 80, false)).toBe(cells)
  })

  it("applies the replay cap only after a repaint", () => {
    const cells: Cell[] = Array.from({ length: 6 }, (_, index) => ({
      id: String(index),
      kind: "user" as const,
      text: `row-${index}`,
    }))
    render(<Transcript cells={cells} replayMaxRows={6} />)
    expect(mockStaticRenders.at(-1)).toBe(6)
    render(<Transcript cells={cells} replayMaxRows={6} epoch={1} />)
    expect(mockStaticRenders.at(-1)).toBe(2)
  })
})
