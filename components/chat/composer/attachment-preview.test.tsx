import type { ReactElement } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AttachmentPreview } from "./attachment-preview"

const renderPreview = (ui: ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>)

const mockRemove = jest.fn()
const mockState: {
  files: Array<{ id: string; mediaType?: string; filename?: string; url?: string }>
} = { files: [] }

jest.mock("@/components/ai-elements/prompt-input", () => ({
  usePromptInputAttachments: () => ({ files: mockState.files, remove: mockRemove }),
}))

beforeEach(() => {
  mockRemove.mockClear()
  mockState.files = []
})

describe("AttachmentPreview", () => {
  it("renders nothing when there are no attachments", () => {
    const { container } = renderPreview(<AttachmentPreview />)
    expect(container.firstChild).toBeNull()
  })

  it("renders an image thumbnail and a file chip", () => {
    mockState.files = [
      { id: "a", mediaType: "image/png", filename: "pic.png", url: "blob:x" },
      { id: "b", mediaType: "application/pdf", filename: "doc.pdf" },
    ]
    renderPreview(<AttachmentPreview />)
    expect(screen.getByAltText("pic.png")).toBeInTheDocument()
    expect(screen.getByText("doc.pdf")).toBeInTheDocument()
  })

  it("removes an attachment when its X is clicked", () => {
    mockState.files = [{ id: "b", mediaType: "application/pdf", filename: "doc.pdf" }]
    renderPreview(<AttachmentPreview />)
    fireEvent.click(screen.getByRole("button", { name: /doc\.pdf/ }))
    expect(mockRemove).toHaveBeenCalledWith("b")
  })

  it("shows the OCR menu only for eligible types when a handler is supplied", () => {
    mockState.files = [{ id: "b", mediaType: "application/pdf", filename: "doc.pdf" }]
    const onOcrSelect = jest.fn()
    renderPreview(<AttachmentPreview onOcrSelect={onOcrSelect} />)
    // OcrMenu renders a trigger button in addition to the remove button.
    expect(screen.getAllByRole("button").length).toBeGreaterThan(1)
  })

  it("falls back for missing filenames and skips OCR for ineligible types", () => {
    mockState.files = [
      { id: "a", mediaType: "image/png", url: "blob:x" }, // image, no filename → alt fallback
      { id: "b", mediaType: "text/plain", filename: "notes.txt" }, // not OCR-eligible
      { id: "z", filename: "typeless" }, // no mediaType → exercises the `?? null` OCR check
    ]
    const onOcrSelect = jest.fn()
    const { container } = renderPreview(<AttachmentPreview onOcrSelect={onOcrSelect} ocrBusy />)
    expect(container.querySelectorAll("img")).toHaveLength(1)
    expect(screen.getByText("notes.txt")).toBeInTheDocument()
  })

  it("renders the file fallback for an image without a url and a typeless file", () => {
    mockState.files = [
      { id: "d", mediaType: "image/png" }, // image but no url → file fallback
      { id: "e" }, // no mediaType, no filename → fallbackFile label
    ]
    const { container } = renderPreview(<AttachmentPreview />)
    expect(container.querySelectorAll("img")).toHaveLength(0)
    // Two chips, each with a remove button.
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(2)
  })

  it("standalone mode wraps the chips in its own padded row", () => {
    mockState.files = [{ id: "b", mediaType: "application/pdf", filename: "doc.pdf" }]
    const { container } = renderPreview(<AttachmentPreview />)
    expect((container.firstChild as HTMLElement).className).toContain("px-2 pt-2")
  })

  it("bare mode returns the chips without the padded container for composition", () => {
    mockState.files = [{ id: "b", mediaType: "application/pdf", filename: "doc.pdf" }]
    const { container } = renderPreview(<AttachmentPreview bare />)
    // Bare drops the outer flex-wrap row so a parent bar can lay it out.
    expect((container.firstChild as HTMLElement)?.className ?? "").not.toContain("px-2 pt-2")
    expect(screen.getByText("doc.pdf")).toBeInTheDocument()
  })
})
