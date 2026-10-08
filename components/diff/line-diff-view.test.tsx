/**
 * @jest-environment jsdom
 */

import { createRef } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// jsdom has no layout, so the real virtualizer would render nothing. The stub
// renders every row and records what it was asked for.
const virtualizerCalls: { count: number; estimate: number }[] = []
const measureElement = jest.fn()
const scrollToIndex = jest.fn()
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
  }: {
    count: number
    estimateSize: (index: number) => number
  }) => {
    virtualizerCalls.push({ count, estimate: estimateSize(0) })
    return {
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({
          index,
          key: index,
          start: index * 20,
          size: 20,
          end: (index + 1) * 20,
          lane: 0,
        })),
      getTotalSize: () => count * 20,
      measureElement,
      scrollToIndex,
    }
  },
}))

import { computeDiff } from "@/lib/artifacts/diff"
import {
  LineDiffView,
  MAX_RENDERED_LINE_CHARS,
  type LineDiffViewHandle,
  visualWidth,
} from "./line-diff-view"

const base = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
const edited = [...base]
edited[19] = "CHANGED"
const diff = computeDiff(base.join("\n"), edited.join("\n"))

beforeEach(() => {
  virtualizerCalls.length = 0
  measureElement.mockClear()
  scrollToIndex.mockClear()
})

describe("LineDiffView", () => {
  it("folds unchanged runs around a change into expandable gaps", () => {
    render(<LineDiffView lines={diff} />)
    const lines = screen.getAllByTestId("line-diff-line")
    // 3 context + removed + added + 3 context
    expect(lines).toHaveLength(8)
    expect(lines.map((l) => l.getAttribute("data-type"))).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
      "removed",
      "added",
      "unchanged",
      "unchanged",
      "unchanged",
    ])
    const gaps = screen.getAllByTestId("line-diff-gap")
    expect(gaps.map((g) => g.textContent)).toEqual([
      'showUnchanged:{"count":16}',
      'showUnchanged:{"count":17}',
    ])
    // Only the folded rows reach the virtualizer.
    expect(virtualizerCalls.at(-1)).toEqual({ count: 10, estimate: 20 })
  })

  it("expands a gap in place", () => {
    render(<LineDiffView lines={diff} />)
    fireEvent.click(screen.getAllByTestId("line-diff-gap")[0])
    expect(screen.getAllByTestId("line-diff-gap")).toHaveLength(1)
    expect(screen.getAllByTestId("line-diff-line")).toHaveLength(8 + 16)
    expect(screen.getByText("line 1")).toBeInTheDocument()
  })

  it("shows every line when context is null", () => {
    render(<LineDiffView lines={diff} context={null} />)
    expect(screen.queryByTestId("line-diff-gap")).toBeNull()
    expect(screen.getAllByTestId("line-diff-line")).toHaveLength(41)
  })

  it("renders pre-built rows as given, headers included", () => {
    render(
      <LineDiffView
        rows={[
          { kind: "header", key: "h0", text: "@@ -1,2 +1,2 @@" },
          { kind: "line", index: 0, line: { type: "removed", content: "a", oldLineNum: 1 } },
          { kind: "line", index: 1, line: { type: "added", content: "b", newLineNum: 1 } },
        ]}
      />
    )
    expect(screen.getByTestId("line-diff-header")).toHaveTextContent("@@ -1,2 +1,2 @@")
    expect(screen.getAllByTestId("line-diff-line")).toHaveLength(2)
    // The +/- sign is visual; the type is spoken.
    expect(screen.getByText("removed")).toHaveClass("sr-only")
    expect(screen.getByText("added")).toHaveClass("sr-only")
  })

  it("opens the file at a line from the gutter, preferring the new side", () => {
    const onOpenLine = jest.fn()
    render(<LineDiffView lines={diff} onOpenLine={onOpenLine} />)
    const buttons = screen.getAllByTestId("line-diff-open")
    expect(buttons[3]).toHaveAccessibleName('openAtLine:{"line":20}')
    fireEvent.click(buttons[4])
    expect(onOpenLine).toHaveBeenCalledWith(
      expect.objectContaining({ type: "added", content: "CHANGED", newLineNum: 20 })
    )
  })

  it("renders plain gutters without an opener", () => {
    render(<LineDiffView lines={diff} />)
    expect(screen.queryByTestId("line-diff-open")).toBeNull()
  })

  it("sizes the scroll width from the longest line without wrapping, and measures rows when wrapping", () => {
    const { rerender } = render(<LineDiffView lines={diff} />)
    const region = screen.getByTestId("line-diff-view")
    expect(region).toHaveAttribute("data-wrap", "false")
    expect((region.firstElementChild as HTMLElement).style.minWidth).toContain("ch")
    expect(measureElement).not.toHaveBeenCalled()

    rerender(<LineDiffView lines={diff} wrap />)
    expect(region).toHaveAttribute("data-wrap", "true")
    expect((region.firstElementChild as HTMLElement).style.minWidth).toBe("")
  })

  it("sizes to its content up to maxHeight", () => {
    const { rerender } = render(<LineDiffView lines={diff} maxHeight={1000} />)
    // 10 folded rows at 20px.
    expect(screen.getByTestId("line-diff-view").style.height).toBe("201px")
    rerender(<LineDiffView lines={diff} maxHeight={120} />)
    expect(screen.getByTestId("line-diff-view").style.height).toBe("120px")
  })

  it("labels the scroll region", () => {
    render(<LineDiffView lines={diff} aria-label="Proposed changes" />)
    expect(screen.getByRole("region", { name: "Proposed changes" })).toBeInTheDocument()
  })
})

describe("LineDiffView revealLine", () => {
  it("scrolls to a visible line and highlights it", () => {
    const ref = createRef<LineDiffViewHandle>()
    render(<LineDiffView ref={ref} lines={diff} />)
    act(() => ref.current!.revealLine({ side: "new", line: 20 }))
    // Row 0 is the head gap, then 3 context lines, then removed (row 4), added (row 5).
    expect(scrollToIndex).toHaveBeenCalledWith(5, { align: "center" })
    const highlighted = screen
      .getAllByTestId("line-diff-line")
      .filter((l) => l.getAttribute("data-highlighted") === "true")
    expect(highlighted).toHaveLength(1)
    expect(highlighted[0]).toHaveTextContent("CHANGED")
  })

  it("unfolds the gap holding a hidden line before scrolling to it", () => {
    const ref = createRef<LineDiffViewHandle>()
    render(<LineDiffView ref={ref} lines={diff} />)
    act(() => ref.current!.revealLine({ side: "old", line: 2 }))
    expect(screen.getAllByTestId("line-diff-gap")).toHaveLength(1)
    // Unfolded head: line 2 is now row 1.
    expect(scrollToIndex).toHaveBeenLastCalledWith(1, { align: "center" })
  })

  it("reveals into pre-built rows by line number", () => {
    const ref = createRef<LineDiffViewHandle>()
    render(
      <LineDiffView
        ref={ref}
        rows={[
          { kind: "header", key: "h0", text: "@@ -10 +10 @@" },
          { kind: "line", index: 0, line: { type: "removed", content: "a", oldLineNum: 10 } },
          { kind: "line", index: 1, line: { type: "added", content: "b", newLineNum: 10 } },
        ]}
      />
    )
    act(() => ref.current!.revealLine({ side: "new", line: 10 }))
    expect(scrollToIndex).toHaveBeenCalledWith(2, { align: "center" })
  })
})

describe("visualWidth", () => {
  it("counts tabs to the next stop and wide characters as two cells", () => {
    expect(visualWidth("abc")).toBe(3)
    expect(visualWidth("\tx")).toBe(5)
    expect(visualWidth("ab\tx")).toBe(5)
    expect(visualWidth("中文")).toBe(4)
  })
})

describe("LineDiffView word emphasis", () => {
  it("marks the characters an edited line changed, on both sides", () => {
    const edit = computeDiff("const a = 1\nkeep", "const a = 2\nkeep")
    render(<LineDiffView lines={edit} context={null} />)
    const marks = screen.getAllByTestId("line-diff-intraline")
    expect(marks.map((m) => m.textContent)).toEqual(["1", "2"])
  })

  it("leaves a rewritten line as a whole-line change", () => {
    const rewrite = computeDiff("abcdef", "uvwxyz")
    render(<LineDiffView lines={rewrite} context={null} />)
    expect(screen.queryByTestId("line-diff-intraline")).toBeNull()
  })
})

describe("LineDiffView split layout", () => {
  it("pairs a removal with its replacement side by side and always wraps", () => {
    render(<LineDiffView lines={diff} layout="split" />)
    const region = screen.getByTestId("line-diff-view")
    expect(region).toHaveAttribute("data-layout", "split")
    expect(region).toHaveAttribute("data-wrap", "true")
    const pairs = screen.getAllByTestId("line-diff-pair")
    // 3 context + 1 changed pair + 3 context
    expect(pairs).toHaveLength(7)
    const changed = pairs[3]
    const halves = changed.querySelectorAll("[data-testid=line-diff-line]")
    expect(halves[0]).toHaveAttribute("data-type", "removed")
    expect(halves[0]).toHaveAttribute("data-side", "old")
    expect(halves[1]).toHaveAttribute("data-type", "added")
    expect(halves[1]).toHaveTextContent("CHANGED")
    expect(screen.getAllByTestId("line-diff-gap")).toHaveLength(2)
  })

  it("leaves the other side blank for a pure addition", () => {
    render(<LineDiffView lines={computeDiff("a", "a\nb")} layout="split" context={null} />)
    expect(screen.getAllByTestId("line-diff-blank")).toHaveLength(1)
  })

  it("reveals a line into the pair that shows it", () => {
    const ref = createRef<LineDiffViewHandle>()
    render(<LineDiffView ref={ref} lines={diff} layout="split" />)
    act(() => ref.current!.revealLine({ side: "new", line: 20 }))
    // Row 0 is the head gap, then 3 context pairs, then the changed pair.
    expect(scrollToIndex).toHaveBeenLastCalledWith(4, { align: "center" })
  })
})

describe("LineDiffView find", () => {
  it("opens with Ctrl/Cmd+F, counts hits and walks them with Enter", () => {
    render(<LineDiffView lines={diff} />)
    fireEvent.keyDown(screen.getByTestId("line-diff-view"), { key: "f", ctrlKey: true })
    const input = screen.getByTestId("line-diff-find-input")
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: "line 1" } })
    // "line 1", "line 10".."line 19": 11 hits.
    expect(screen.getByTestId("line-diff-find-count")).toHaveTextContent(
      'find.count:{"current":1,"total":11}'
    )
    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.getByTestId("line-diff-find-count")).toHaveTextContent('"current":2')
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
    // Wraps from the first hit to the last.
    expect(screen.getByTestId("line-diff-find-count")).toHaveTextContent('"current":11')
  })

  it("unfolds the gap that holds a hit and marks the current one", () => {
    render(<LineDiffView lines={diff} />)
    fireEvent.keyDown(screen.getByTestId("line-diff-view"), { key: "f", metaKey: true })
    fireEvent.change(screen.getByTestId("line-diff-find-input"), { target: { value: "line 2" } })
    // "line 2" sits in the folded head; finding it unfolds that gap.
    expect(screen.getAllByTestId("line-diff-gap")).toHaveLength(1)
    const current = screen
      .getAllByTestId("line-diff-hit")
      .filter((h) => h.getAttribute("data-current") === "true")
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveTextContent("line 2")
  })

  it("says when nothing matches and closes with Escape", () => {
    const ref = createRef<LineDiffViewHandle>()
    render(<LineDiffView ref={ref} lines={diff} />)
    act(() => ref.current!.openFind())
    const input = screen.getByTestId("line-diff-find-input")
    fireEvent.change(input, { target: { value: "zzz" } })
    expect(screen.getByTestId("line-diff-find-count")).toHaveTextContent("find.none")
    expect(screen.getByTestId("line-diff-find-next")).toBeDisabled()
    fireEvent.keyDown(input, { key: "Escape" })
    expect(screen.queryByTestId("line-diff-find")).toBeNull()
    expect(screen.getByTestId("line-diff-view")).toHaveFocus()
  })
})

describe("LineDiffView long lines", () => {
  it("draws the first 10k characters of a minified line and summarises the rest", () => {
    const long = "y".repeat(MAX_RENDERED_LINE_CHARS + 250)
    render(<LineDiffView lines={computeDiff("x", long)} context={null} />)
    const added = screen
      .getAllByTestId("line-diff-line")
      .find((l) => l.getAttribute("data-type") === "added")!
    expect(added.textContent).toContain("y".repeat(MAX_RENDERED_LINE_CHARS))
    expect(added.textContent).not.toContain("y".repeat(MAX_RENDERED_LINE_CHARS + 1))
    expect(screen.getByTestId("line-diff-clipped")).toHaveTextContent('clipped:{"count":250}')
    // The scroll width follows what is drawn, not the whole line.
    const sizer = screen.getByTestId("line-diff-view").firstElementChild as HTMLElement
    expect(sizer.style.minWidth).toContain(`${MAX_RENDERED_LINE_CHARS + 7}ch`)
  })
})
