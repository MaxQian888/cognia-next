/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { CanvasInlinePart } from "./canvas-inline-part"
import type { CanvasInlinePart as CanvasInlinePartType } from "@/lib/claude/parts-extensions"
import type { CanvasDocument } from "@/types"

const mockCanvasDocs: Record<string, CanvasDocument | undefined> = {}
const mockReveal = jest.fn()
const mockPush = jest.fn()
let mockPathname = "/"

jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: (selector: (s: { canvasDocuments: typeof mockCanvasDocs }) => unknown) =>
    selector({ canvasDocuments: mockCanvasDocs }),
}))

jest.mock("@/lib/artifacts/reveal", () => ({
  revealCanvasDocument: (...args: unknown[]) => mockReveal(...args),
}))

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => mockPathname,
}))

jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string }) => (
    <pre data-testid="code-block" data-language={language}>
      {code}
    </pre>
  ),
}))

jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}))

const makeCanvas = (overrides: Partial<CanvasDocument> = {}): CanvasDocument =>
  ({
    id: "doc-1",
    sessionId: "sess",
    title: "Demo",
    content: "hello world",
    language: "typescript",
    type: "code",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }) as CanvasDocument

const part = (overrides: Partial<CanvasInlinePartType> = {}): CanvasInlinePartType => ({
  type: "canvas",
  canvasId: "doc-1",
  title: "Demo",
  ...overrides,
})

beforeEach(() => {
  for (const k of Object.keys(mockCanvasDocs)) delete mockCanvasDocs[k]
  mockReveal.mockReset()
  mockReveal.mockReturnValue(makeCanvas())
  mockPush.mockReset()
  mockPathname = "/"
})

describe("CanvasInlinePart", () => {
  it("renders a code preview for `type: code` documents", () => {
    mockCanvasDocs["doc-1"] = makeCanvas({ content: "let x = 1", language: "typescript" })
    render(<CanvasInlinePart part={part()} />)
    expect(screen.getByTestId("canvas-inline-part")).toHaveAttribute("data-canvas-id", "doc-1")
    expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "typescript")
    expect(screen.getByTestId("code-block")).toHaveTextContent("let x = 1")
  })

  it("renders a markdown preview for `type: text` documents", () => {
    mockCanvasDocs["doc-1"] = makeCanvas({ type: "text", content: "# Heading\n\nbody" })
    render(<CanvasInlinePart part={part()} />)
    expect(screen.getByTestId("md")).toHaveTextContent("# Heading")
  })

  it("renders a cleared placeholder when the canvas row is missing", () => {
    render(<CanvasInlinePart part={part({ title: "lost-canvas" })} />)
    const node = screen.getByTestId("canvas-inline-part-missing")
    expect(node).toBeInTheDocument()
    expect(node).toHaveTextContent("lost-canvas")
    expect(node).toHaveTextContent("(cleared)")
  })

  it("collapses + re-expands the preview body", () => {
    mockCanvasDocs["doc-1"] = makeCanvas()
    render(<CanvasInlinePart part={part()} />)
    expect(screen.getByTestId("canvas-inline-part-body")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("canvas-inline-part-toggle"))
    expect(screen.queryByTestId("canvas-inline-part-body")).toBeNull()
    fireEvent.click(screen.getByTestId("canvas-inline-part-toggle"))
    expect(screen.getByTestId("canvas-inline-part-body")).toBeInTheDocument()
  })

  it("Open-in-Canvas reveals the document through the store, not a route", () => {
    mockCanvasDocs["abc"] = makeCanvas({ id: "abc" })
    const { container } = render(<CanvasInlinePart part={part({ canvasId: "abc" })} />)
    const open = screen.getByTestId("canvas-inline-part-open")
    expect(open.tagName).toBe("BUTTON")

    // Regression pin: `/canvas/<id>` is not a route in this static export, so
    // an anchor here 404s on every click. It must never come back.
    expect(container.querySelector('a[href^="/canvas/"]')).toBeNull()

    fireEvent.click(open)
    expect(mockReveal).toHaveBeenCalledWith("abc")
  })

  it("routes home first when the card is not on the shell route", () => {
    mockPathname = "/inbox/c"
    mockCanvasDocs["abc"] = makeCanvas({ id: "abc" })
    render(<CanvasInlinePart part={part({ canvasId: "abc" })} />)
    fireEvent.click(screen.getByTestId("canvas-inline-part-open"))
    expect(mockPush).toHaveBeenCalledWith("/")
  })

  it("stays put when the document is gone", () => {
    mockReveal.mockReturnValue(null)
    mockPathname = "/inbox/c"
    mockCanvasDocs["abc"] = makeCanvas({ id: "abc" })
    render(<CanvasInlinePart part={part({ canvasId: "abc" })} />)
    fireEvent.click(screen.getByTestId("canvas-inline-part-open"))
    expect(mockPush).not.toHaveBeenCalled()
  })

  it("uses the maxHeight override on the body wrapper", () => {
    mockCanvasDocs["doc-1"] = makeCanvas()
    render(<CanvasInlinePart part={part({ maxHeight: 120 })} />)
    const body = screen.getByTestId("canvas-inline-part-body")
    expect(body.getAttribute("style")).toContain("max-height: 120px")
  })
})
