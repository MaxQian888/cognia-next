/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { DiffPreview } from "./diff-preview"

describe("DiffPreview", () => {
  it("renders removed lines then added lines", () => {
    render(<DiffPreview oldText={"a\nb"} newText={"c"} />)
    const removed = screen.getAllByTestId("diff-removed")
    const added = screen.getAllByTestId("diff-added")
    expect(removed).toHaveLength(2)
    expect(added).toHaveLength(1)
    expect(removed[0]).toHaveTextContent("- a")
    expect(added[0]).toHaveTextContent("+ c")
  })

  it("omits the removed block for pure additions (write preview)", () => {
    render(<DiffPreview oldText="" newText={"line1\nline2"} />)
    expect(screen.queryAllByTestId("diff-removed")).toHaveLength(0)
    expect(screen.getAllByTestId("diff-added")).toHaveLength(2)
  })

  it("omits the added block for pure removals", () => {
    render(<DiffPreview oldText="gone" newText="" />)
    expect(screen.getAllByTestId("diff-removed")).toHaveLength(1)
    expect(screen.queryAllByTestId("diff-added")).toHaveLength(0)
  })

  it("highlights the intraline changed run on a same-index modification (gap5)", () => {
    render(<DiffPreview oldText="const a = 1" newText="const a = 2" />)
    const intraline = screen.getAllByTestId("diff-intraline")
    // one emphasized run on the removed side ("1") + one on the added side ("2")
    expect(intraline.map((n) => n.textContent)).toEqual(["1", "2"])
    // the shared prefix is NOT emphasized
    expect(screen.getByTestId("diff-removed")).toHaveTextContent("const a = 1")
  })

  it("does not emphasize anything for a pure addition (no counterpart line)", () => {
    render(<DiffPreview oldText="" newText="brand new" />)
    expect(screen.queryAllByTestId("diff-intraline")).toHaveLength(0)
  })
})
