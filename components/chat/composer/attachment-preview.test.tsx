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
})
