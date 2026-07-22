import { fireEvent, render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ContextChipBar } from "./context-chip-bar"
import { useChatStore } from "@/stores/chat"

// Drive the attachment side through a controllable provider mock; the reference
// side reads the real chat-store.
const mockState: {
  files: Array<{ id: string; mediaType?: string; filename?: string; url?: string }>
} = { files: [] }

jest.mock("@/components/ai-elements/prompt-input", () => ({
  usePromptInputAttachments: () => ({ files: mockState.files, remove: jest.fn() }),
}))

const renderBar = () =>
  render(
    <TooltipProvider>
      <ContextChipBar />
    </TooltipProvider>
  )

beforeEach(() => {
  useChatStore.getState().clear()
  mockState.files = []
})

describe("ContextChipBar", () => {
  it("renders nothing when there are no references and no attachments", () => {
    const { container } = renderBar()
    expect(container.firstChild).toBeNull()
  })

  it("does not render an empty bar for ordinary draft text without a link", () => {
    const { container } = render(
      <TooltipProvider>
        <ContextChipBar text="ordinary draft" onRemoveLink={jest.fn()} />
      </TooltipProvider>
    )
    expect(container.firstChild).toBeNull()
  })

  it("merges references and attachments into one labelled group", () => {
    useChatStore.getState().addReferencedPath({
      absolute: "/repo/src/index.ts",
      relative: "src/index.ts",
      isDir: false,
    })
    mockState.files = [{ id: "b", mediaType: "application/pdf", filename: "doc.pdf" }]
    renderBar()

    const group = screen.getByRole("group", { name: /attached files, links, and references/i })
    expect(group).toBeInTheDocument()
    // Both the @-reference and the attachment chip live inside the one bar.
    expect(screen.getByText("src/index.ts")).toBeInTheDocument()
    expect(screen.getByText("doc.pdf")).toBeInTheDocument()
  })

  it("shows a compact size hint when an attachment carries a data: URL", () => {
    mockState.files = [
      {
        id: "a",
        mediaType: "text/plain",
        filename: "a.txt",
        url: "data:text/plain;base64,aGVsbG8=",
      },
    ]
    renderBar()
    // "hello" base64 decodes to 5 bytes.
    expect(screen.getByText("5B")).toBeInTheDocument()
  })

  it("includes recognized web links in the same context bar", () => {
    const onRemoveLink = jest.fn()
    render(
      <TooltipProvider>
        <ContextChipBar text="Read https://example.com/docs" onRemoveLink={onRemoveLink} />
      </TooltipProvider>
    )
    expect(screen.getByText("example.com")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Remove example.com" }))
    expect(onRemoveLink).toHaveBeenCalledWith("https://example.com/docs")
  })

  it("omits the size hint when attachments only carry blob: previews", () => {
    mockState.files = [{ id: "a", mediaType: "image/png", filename: "p.png", url: "blob:x" }]
    renderBar()
    expect(screen.queryByText(/B$/)).toBeNull()
  })
})
