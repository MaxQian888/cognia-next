/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { ReviewHunkItem } from "./review-hunk-item"
import type { CanvasReviewItem } from "@/types"

const item = (over: Partial<CanvasReviewItem> = {}): CanvasReviewItem => ({
  id: "h1",
  actionType: "custom",
  changeType: "replace",
  originalText: "old",
  proposedText: "new",
  status: "pending",
  range: { startLine: 2, endLine: 4 },
  diffLines: [
    { type: "removed", content: "old", lineNumber: 2 },
    { type: "added", content: "new", newLineNumber: 2 },
  ],
  ...over,
})

describe("ReviewHunkItem", () => {
  it("renders the change type label and the line range", () => {
    render(<ReviewHunkItem item={item()} onAccept={jest.fn()} onReject={jest.fn()} />)
    expect(screen.getByText("hunkReplace")).toBeInTheDocument()
    expect(screen.getByText(/2-4/)).toBeInTheDocument()
  })

  it("renders a single line number when start === end", () => {
    render(
      <ReviewHunkItem
        item={item({ range: { startLine: 5, endLine: 5 } })}
        onAccept={jest.fn()}
        onReject={jest.fn()}
      />
    )
    expect(screen.getByText(/\b5\b/)).toBeInTheDocument()
  })

  it("fires onAccept / onReject with the hunk id", () => {
    const onAccept = jest.fn()
    const onReject = jest.fn()
    render(<ReviewHunkItem item={item()} onAccept={onAccept} onReject={onReject} />)
    fireEvent.click(screen.getByText("accept"))
    fireEvent.click(screen.getByText("reject"))
    expect(onAccept).toHaveBeenCalledWith("h1")
    expect(onReject).toHaveBeenCalledWith("h1")
  })

  it("expands the inline diff preview", () => {
    render(<ReviewHunkItem item={item()} onAccept={jest.fn()} onReject={jest.fn()} />)
    fireEvent.click(screen.getByText("viewChanges"))
    expect(screen.getByText("old")).toBeInTheDocument()
    expect(screen.getByText("new")).toBeInTheDocument()
  })

  it("disables the controls when disabled", () => {
    const onAccept = jest.fn()
    render(<ReviewHunkItem item={item()} onAccept={onAccept} onReject={jest.fn()} disabled />)
    const accept = screen.getByText("accept").closest("button")!
    expect(accept).toBeDisabled()
    fireEvent.click(accept)
    expect(onAccept).not.toHaveBeenCalled()
  })

  it("renders accepted / rejected states and an unchanged diff line with a custom class", () => {
    const { rerender } = render(
      <ReviewHunkItem
        className="custom-class"
        item={item({
          status: "accepted",
          diffLines: [
            { type: "unchanged", content: "ctx", lineNumber: 1, newLineNumber: 1 },
            { type: "added", content: "new", newLineNumber: 2 },
          ],
        })}
        onAccept={jest.fn()}
        onReject={jest.fn()}
      />
    )
    fireEvent.click(screen.getByText("viewChanges"))
    expect(screen.getByText("ctx")).toBeInTheDocument()
    rerender(
      <ReviewHunkItem
        item={item({ status: "rejected" })}
        onAccept={jest.fn()}
        onReject={jest.fn()}
      />
    )
    expect(screen.getByText("hunkReplace")).toBeInTheDocument()
  })

  it("renders insert / delete change types", () => {
    const { rerender } = render(
      <ReviewHunkItem
        item={item({ changeType: "insert" })}
        onAccept={jest.fn()}
        onReject={jest.fn()}
      />
    )
    expect(screen.getByText("hunkInsert")).toBeInTheDocument()
    rerender(
      <ReviewHunkItem
        item={item({ changeType: "delete" })}
        onAccept={jest.fn()}
        onReject={jest.fn()}
      />
    )
    expect(screen.getByText("hunkDelete")).toBeInTheDocument()
  })
})
