/**
 * @jest-environment jsdom
 *
 * Tests for CanvasExportMenu — confirms it lists the gated export formats and
 * routes clicks through the document-export helpers with a toast.
 */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Flatten Radix menu + tooltip so items render inline (Radix portals/providers
// are painful under jsdom — the repo's established pattern).
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
}))
jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Self-contained factories (no outer refs) to avoid the jest.mock hoisting TDZ.
jest.mock("@/lib/canvas/document-export", () => ({
  getCanvasExportFormats: jest.fn(() => ["raw", "html"]),
  exportCanvasDocument: jest.fn(async () => "Doc.md"),
  copyCanvasDocumentToClipboard: jest.fn(async () => true),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { CanvasExportMenu } from "./canvas-export-menu"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { toast } from "sonner"
import {
  copyCanvasDocumentToClipboard,
  exportCanvasDocument,
  getCanvasExportFormats,
} from "@/lib/canvas/document-export"

const mockToast = toast as unknown as { success: jest.Mock; error: jest.Mock }
const mockFormats = getCanvasExportFormats as unknown as jest.Mock
const mockExport = exportCanvasDocument as unknown as jest.Mock
const mockCopy = copyCanvasDocumentToClipboard as unknown as jest.Mock

function seedDoc() {
  let id = ""
  act(() => {
    id = useArtifactStore.getState().createCanvasDocument({
      sessionId: "s1",
      title: "Doc",
      content: "hi",
      language: "markdown",
      type: "text",
    })
  })
  return id
}

beforeEach(() => {
  jest.clearAllMocks()
  mockFormats.mockReturnValue(["raw", "html"])
  act(() => {
    Object.keys(useArtifactStore.getState().canvasDocuments).forEach((id) =>
      useArtifactStore.getState().deleteCanvasDocument(id)
    )
  })
})

describe("CanvasExportMenu", () => {
  it("lists the gated formats and a copy action", () => {
    const id = seedDoc()
    render(<CanvasExportMenu documentId={id} />)
    expect(screen.getByText("Download source")).toBeInTheDocument()
    expect(screen.getByText("Download as HTML")).toBeInTheDocument()
    expect(screen.getByText("Copy to clipboard")).toBeInTheDocument()
  })

  it("exports the selected format and toasts the filename", async () => {
    const user = userEvent.setup()
    const id = seedDoc()
    render(<CanvasExportMenu documentId={id} />)
    await user.click(screen.getByText("Download source"))
    expect(mockExport).toHaveBeenCalledWith(expect.objectContaining({ id }), "raw")
    expect(mockToast.success).toHaveBeenCalledWith("Downloaded Doc.md")
  })

  it("copies to the clipboard and toasts success", async () => {
    const user = userEvent.setup()
    const id = seedDoc()
    render(<CanvasExportMenu documentId={id} />)
    await user.click(screen.getByText("Copy to clipboard"))
    expect(mockCopy).toHaveBeenCalledWith(expect.objectContaining({ id }))
    expect(mockToast.success).toHaveBeenCalledWith("Copied to clipboard")
  })

  it("toasts an error when the copy fails", async () => {
    const user = userEvent.setup()
    mockCopy.mockResolvedValueOnce(false)
    const id = seedDoc()
    render(<CanvasExportMenu documentId={id} />)
    await user.click(screen.getByText("Copy to clipboard"))
    expect(mockToast.error).toHaveBeenCalledWith("Couldn't copy to clipboard")
  })

  it("disables the trigger when there is no active document", () => {
    render(<CanvasExportMenu documentId={null} />)
    expect(screen.getByRole("button", { name: /Export document/i })).toBeDisabled()
    expect(screen.queryByText("Download source")).not.toBeInTheDocument()
  })

  it("applies a custom className to the trigger", () => {
    const id = seedDoc()
    render(<CanvasExportMenu documentId={id} className="custom-trigger" />)
    expect(screen.getByTestId("canvas-export-trigger")).toHaveClass("custom-trigger")
  })

  it("offers every format the export contract declares, including the rendered ones", () => {
    mockFormats.mockReturnValueOnce(["raw", "png", "pdf"])
    const id = seedDoc()
    render(<CanvasExportMenu documentId={id} />)
    expect(screen.getByText("Download source")).toBeInTheDocument()
    expect(screen.getByText("PNG image")).toBeInTheDocument()
    expect(screen.getByText("PDF")).toBeInTheDocument()
  })

  it("does not toast when the export produces no file", async () => {
    const user = userEvent.setup()
    mockExport.mockResolvedValueOnce(null)
    const id = seedDoc()
    render(<CanvasExportMenu documentId={id} />)
    await user.click(screen.getByText("Download source"))
    expect(mockToast.success).not.toHaveBeenCalled()
  })

  it("reports a failed render, which a cancelled text save must not do", async () => {
    // `null` means unsupported / failed / cancelled. For a text format that is
    // usually "the user closed the save dialog" — no error belongs there. For a
    // rendered format it means the render itself did not produce a file.
    const user = userEvent.setup()
    mockFormats.mockReturnValue(["raw", "png"])
    mockExport.mockResolvedValue(null)
    const id = seedDoc()
    render(<CanvasExportMenu documentId={id} />)

    await user.click(screen.getByText("Download source"))
    expect(mockToast.error).not.toHaveBeenCalled()

    await user.click(screen.getByText("PNG image"))
    expect(mockToast.error).toHaveBeenCalledWith("Couldn't render the document")
  })
})
