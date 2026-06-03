import { fireEvent, render, screen } from "@testing-library/react"
import { OcrTextOverlay } from "./ocr-text-overlay"
import type { OcrDocumentPage } from "@/types/ocr"

const page: OcrDocumentPage = {
  pageNumber: 1,
  width: 200,
  height: 100,
  blocks: [
    {
      id: "0.0",
      type: "paragraph",
      text: "hello world",
      bbox: { x: 20, y: 10, width: 100, height: 20 },
      readingOrderIndex: 0,
      provenance: { providerId: "ocrs", pageNumber: 1 },
    },
    {
      id: "0.1",
      type: "line",
      text: "no-bbox",
      readingOrderIndex: 1,
      provenance: { providerId: "ocrs", pageNumber: 1 },
    },
  ],
}

describe("OcrTextOverlay", () => {
  it("renders a selectable span per bbox'd block, positioned as a percentage", () => {
    render(<OcrTextOverlay imageSrc="blob:img" page={page} />)
    const span = screen.getByText("hello world")
    expect(span).toHaveAttribute("data-block-id", "0.0")
    // 20/200 = 10%, 10/100 = 10%, 100/200 = 50%, 20/100 = 20%
    expect(span.style.left).toBe("10%")
    expect(span.style.top).toBe("10%")
    expect(span.style.width).toBe("50%")
    expect(span.style.height).toBe("20%")
    // The block without a bbox is skipped.
    expect(screen.queryByText("no-bbox")).not.toBeInTheDocument()
  })

  it("fires onBlockClick with the citation id", () => {
    const onBlockClick = jest.fn()
    render(<OcrTextOverlay imageSrc="blob:img" page={page} onBlockClick={onBlockClick} />)
    fireEvent.click(screen.getByText("hello world"))
    expect(onBlockClick).toHaveBeenCalledWith("0.0")
  })

  it("activates a block on Enter/Space for keyboard users", () => {
    const onBlockClick = jest.fn()
    render(<OcrTextOverlay imageSrc="blob:img" page={page} onBlockClick={onBlockClick} />)
    fireEvent.keyDown(screen.getByText("hello world"), { key: "Enter" })
    expect(onBlockClick).toHaveBeenCalledWith("0.0")
  })

  it("highlights the targeted block", () => {
    render(<OcrTextOverlay imageSrc="blob:img" page={page} highlightedId="0.0" />)
    expect(screen.getByText("hello world").className).toMatch(/ring-primary/)
  })

  it("renders just the image (no spans) when the page has no positionable blocks", () => {
    const empty: OcrDocumentPage = { pageNumber: 1, blocks: [] }
    render(<OcrTextOverlay imageSrc="blob:img" page={empty} />)
    expect(screen.getByTestId("ocr-text-overlay")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("ignores other keys and tolerates a missing click handler", () => {
    render(<OcrTextOverlay imageSrc="blob:img" page={page} />)
    const span = screen.getByText("hello world")
    fireEvent.keyDown(span, { key: "a" })
    fireEvent.click(span) // no onBlockClick provided → must not throw
    expect(span).toBeInTheDocument()
  })

  it("falls back to bbox extents when page dimensions are absent", () => {
    const noDim: OcrDocumentPage = { ...page, width: undefined, height: undefined }
    render(<OcrTextOverlay imageSrc="blob:img" page={noDim} />)
    // width inferred = 20+100 = 120, height = 10+20 = 30 → left 20/120 ≈ 16.66%
    const span = screen.getByText("hello world")
    expect(span.style.left.startsWith("16.6")).toBe(true)
  })
})
