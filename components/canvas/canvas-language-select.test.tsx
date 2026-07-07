/**
 * @jest-environment jsdom
 *
 * Tests for CanvasLanguageSelect — confirms it changes the active document's
 * language and derives the type, and renders nothing without a document.
 */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Radix Select is portal/pointer-heavy in jsdom; flatten it and expose two
// value-setters so we can drive onValueChange deterministically.
jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) => (
    <div data-testid="select-root" data-value={value}>
      <button type="button" data-testid="pick-python" onClick={() => onValueChange("python")} />
      <button type="button" data-testid="pick-markdown" onClick={() => onValueChange("markdown")} />
      {children}
    </div>
  ),
  SelectTrigger: ({ children, ...props }: { children: React.ReactNode }) => (
    <div {...props}>{children}</div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-option={value}>{children}</div>
  ),
  SelectValue: () => null,
}))

import { CanvasLanguageSelect } from "./canvas-language-select"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

function seedDoc(language: "markdown" | "javascript" = "markdown") {
  let id = ""
  act(() => {
    id = useArtifactStore.getState().createCanvasDocument({
      sessionId: "s1",
      title: "Doc",
      content: "x",
      language,
      type: language === "markdown" ? "text" : "code",
    })
  })
  return id
}

beforeEach(() => {
  act(() => {
    Object.keys(useArtifactStore.getState().canvasDocuments).forEach((id) =>
      useArtifactStore.getState().deleteCanvasDocument(id)
    )
  })
})

describe("CanvasLanguageSelect", () => {
  it("renders nothing when there is no active document", () => {
    const { container } = render(<CanvasLanguageSelect documentId={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("reflects the document's current language", () => {
    const id = seedDoc("javascript")
    render(<CanvasLanguageSelect documentId={id} />)
    expect(screen.getByTestId("select-root")).toHaveAttribute("data-value", "javascript")
    // All language options are offered.
    expect(screen.getByText("Python")).toBeInTheDocument()
    expect(screen.getByText("Mermaid")).toBeInTheDocument()
  })

  it("changes language to a code type and derives type=code", async () => {
    const user = userEvent.setup()
    const id = seedDoc("markdown")
    render(<CanvasLanguageSelect documentId={id} />)
    await user.click(screen.getByTestId("pick-python"))
    const doc = useArtifactStore.getState().canvasDocuments[id]
    expect(doc.language).toBe("python")
    expect(doc.type).toBe("code")
  })

  it("changing to markdown derives type=text", async () => {
    const user = userEvent.setup()
    const id = seedDoc("javascript")
    render(<CanvasLanguageSelect documentId={id} />)
    await user.click(screen.getByTestId("pick-markdown"))
    const doc = useArtifactStore.getState().canvasDocuments[id]
    expect(doc.language).toBe("markdown")
    expect(doc.type).toBe("text")
  })
})
