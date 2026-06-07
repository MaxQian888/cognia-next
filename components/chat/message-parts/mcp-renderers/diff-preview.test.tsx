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
})
