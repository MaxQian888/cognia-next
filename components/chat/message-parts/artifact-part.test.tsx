/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ArtifactPart } from "./artifact-part"
import type { ArtifactPart as ArtifactPartType } from "@/lib/claude/parts-extensions"
import type { Artifact } from "@/types"

const mockArtifacts: Record<string, Artifact | undefined> = {}
const mockRevealArtifact = jest.fn()
const mockCopy = jest.fn().mockResolvedValue(true)

jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: (selector: (s: { artifacts: typeof mockArtifacts }) => unknown) =>
    selector({ artifacts: mockArtifacts }),
}))

jest.mock("@/lib/artifacts/reveal", () => ({
  revealArtifactInWorkspace: (...args: unknown[]) => mockRevealArtifact(...args),
}))

const mockExportArtifact = jest.fn()
jest.mock("@/lib/artifacts/export", () => ({
  exportArtifact: (...args: unknown[]) => mockExportArtifact(...args),
}))

const mockToastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => mockToastError(...a) } }))

jest.mock("@/hooks/ui/use-copy", () => ({
  useCopy: () => ({ copy: mockCopy, copied: false, isCopying: false }),
}))

jest.mock("@/components/artifacts/artifact-preview", () => ({
  ArtifactPreview: ({
    artifact,
    density,
  }: {
    artifact: { id: string; title: string }
    density?: string
  }) => (
    <div data-testid="artifact-preview" data-artifact-id={artifact.id} data-density={density}>
      preview:{artifact.title}
    </div>
  ),
}))

jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string }) => (
    <pre data-testid="artifact-part-source" data-language={language}>
      {code}
    </pre>
  ),
}))

const createPart = (overrides: Partial<ArtifactPartType> = {}): ArtifactPartType => ({
  type: "artifact",
  artifactId: "art-1",
  title: "demo-artifact",
  kind: "code",
  ...overrides,
})

const createArtifactRow = (overrides: Partial<Artifact> = {}): Artifact =>
  ({
    id: "art-1",
    sessionId: "sess",
    messageId: "msg",
    type: "code",
    title: "demo-artifact",
    content: "console.log('hi')",
    language: "typescript",
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }) as Artifact

beforeEach(() => {
  for (const k of Object.keys(mockArtifacts)) delete mockArtifacts[k]
  mockRevealArtifact.mockClear()
  mockCopy.mockClear()
})

describe("ArtifactPart", () => {
  it("renders ArtifactPreview when the store has the row", () => {
    mockArtifacts["art-1"] = createArtifactRow()
    render(<ArtifactPart part={createPart()} />)

    expect(screen.getByTestId("artifact-part")).toHaveAttribute("data-artifact-id", "art-1")
    expect(screen.getByTestId("artifact-preview")).toHaveAttribute("data-artifact-id", "art-1")
  })

  it("renders the cleared placeholder when the row is missing", () => {
    render(<ArtifactPart part={createPart({ title: "lost-artifact" })} />)

    const node = screen.getByTestId("artifact-part-missing")
    expect(node).toBeInTheDocument()
    expect(node).toHaveTextContent("lost-artifact")
    expect(node).toHaveTextContent("(cleared)")
  })

  it("collapses and re-expands the preview body", () => {
    mockArtifacts["art-1"] = createArtifactRow()
    render(<ArtifactPart part={createPart()} />)

    expect(screen.getByTestId("artifact-preview")).toBeInTheDocument()

    const toggle = screen.getByTestId("artifact-part-toggle")
    fireEvent.click(toggle)

    expect(screen.queryByTestId("artifact-preview")).toBeNull()
    expect(toggle).toHaveAttribute("aria-expanded", "false")

    fireEvent.click(toggle)
    expect(screen.getByTestId("artifact-preview")).toBeInTheDocument()
  })

  it("honors defaultOpen=false", () => {
    mockArtifacts["art-1"] = createArtifactRow()
    render(<ArtifactPart part={createPart({ defaultOpen: false })} />)

    expect(screen.queryByTestId("artifact-preview")).toBeNull()
  })

  it("triggers revealArtifactInWorkspace when Open-in-Canvas is clicked", () => {
    mockArtifacts["art-1"] = createArtifactRow()
    render(<ArtifactPart part={createPart()} />)

    fireEvent.click(screen.getByTestId("artifact-part-open-canvas"))

    expect(mockRevealArtifact).toHaveBeenCalledWith("art-1")
  })

  it("copies the artifact content via clipboard hook", () => {
    mockArtifacts["art-1"] = createArtifactRow({ content: "copy-me" })
    render(<ArtifactPart part={createPart()} />)

    fireEvent.click(screen.getByTestId("artifact-part-copy"))
    expect(mockCopy).toHaveBeenCalledWith("copy-me")
  })

  it("saves through the shared exporter, honouring the artifact's export contract", async () => {
    // The hand-rolled version this replaces forced `text/plain` and built the
    // extension from `artifact.type`, so a chart downloaded as `chart.chart`.
    // It also used an `<a download>` anchor, which no-ops in a mobile WebView.
    mockArtifacts["art-1"] = createArtifactRow({
      content: "download-payload",
      title: "my-file",
      language: "typescript",
    })
    mockExportArtifact.mockResolvedValue({ kind: "saved", location: "/tmp/my-file.ts" })
    const createElementSpy = jest.spyOn(document, "createElement")

    render(<ArtifactPart part={createPart()} />)
    fireEvent.click(screen.getByTestId("artifact-part-download"))
    await waitFor(() => expect(mockExportArtifact).toHaveBeenCalled())

    const [artifact, format] = mockExportArtifact.mock.calls[0]
    expect(artifact).toMatchObject({ id: "art-1" })
    // Never a rasterisation: a one-click download stays the source.
    expect(["raw", "html", "svg"]).toContain(format)
    expect(createElementSpy.mock.calls.filter(([tag]) => tag === "a")).toHaveLength(0)

    createElementSpy.mockRestore()
  })

  it("surfaces a failed save instead of failing silently", async () => {
    mockArtifacts["art-1"] = createArtifactRow()
    mockExportArtifact.mockResolvedValue({ kind: "error", message: "disk full" })
    render(<ArtifactPart part={createPart()} />)
    fireEvent.click(screen.getByTestId("artifact-part-download"))
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ description: "disk full" })
      )
    )
  })

  it("does not invoke clipboard or download when the artifact is missing", () => {
    render(<ArtifactPart part={createPart()} />)

    expect(screen.queryByTestId("artifact-part")).toBeNull()
    expect(mockCopy).not.toHaveBeenCalled()
  })

  describe("preview deferral", () => {
    it("previews a normal artifact once the card is near the viewport", () => {
      // jsdom has no layout, so every rect is 0x0 at the origin — which the
      // near-viewport latch correctly reads as on-screen.
      mockArtifacts["art-1"] = createArtifactRow({ type: "document", content: "# short" })
      render(<ArtifactPart part={createPart()} />)
      expect(screen.getByTestId("artifact-preview")).toBeInTheDocument()
      expect(screen.queryByTestId("artifact-part-preview-anyway")).toBeNull()
    })

    it("keeps a React artifact behind a click regardless of its size", () => {
      // It costs a whole runtime load, which a scroll must not trigger.
      mockArtifacts["art-1"] = createArtifactRow({ type: "react", content: "<App/>" })
      render(<ArtifactPart part={createPart()} />)
      expect(screen.queryByTestId("artifact-preview")).toBeNull()
      expect(screen.getByTestId("artifact-part-preview-anyway")).toBeInTheDocument()
    })

    it("keeps a large artifact behind a click", () => {
      mockArtifacts["art-1"] = createArtifactRow({
        type: "html",
        content: "<p>x</p>".repeat(4000),
      })
      render(<ArtifactPart part={createPart()} />)
      expect(screen.queryByTestId("artifact-preview")).toBeNull()
      expect(screen.getByTestId("artifact-part-preview-anyway")).toBeInTheDocument()
    })

    it("renders it when the user asks", () => {
      mockArtifacts["art-1"] = createArtifactRow({ type: "react", content: "<App/>" })
      render(<ArtifactPart part={createPart()} />)
      fireEvent.click(screen.getByTestId("artifact-part-preview-anyway"))
      expect(screen.getByTestId("artifact-preview")).toBeInTheDocument()
    })
  })

  describe("header", () => {
    it("labels the kind in the reader's language instead of the raw type id", () => {
      mockArtifacts["art-1"] = createArtifactRow({
        type: "document",
        content: "# Checkout\n\n- fixed",
        language: "markdown",
      })
      render(<ArtifactPart part={createPart({ kind: "document" })} />)
      const meta = screen.getByTestId("artifact-part-meta")
      expect(meta).toHaveTextContent("Document")
      expect(meta).not.toHaveTextContent("document")
      expect(meta).toHaveTextContent("3 lines")
      expect(screen.getByTestId("artifact-part-type-icon")).toBeInTheDocument()
    })

    it("names the language for code, and only for code", () => {
      mockArtifacts["art-1"] = createArtifactRow({ content: "a\nb", language: "typescript" })
      render(<ArtifactPart part={createPart()} />)
      expect(screen.getByTestId("artifact-part-meta")).toHaveTextContent("TypeScript")
    })

    it("shows the version once the artifact has been revised", () => {
      mockArtifacts["art-1"] = createArtifactRow({ version: 3 })
      render(<ArtifactPart part={createPart()} />)
      expect(screen.getByTestId("artifact-part-meta")).toHaveTextContent("v3")
    })

    it("leaves a first version and a data-model line count out", () => {
      mockArtifacts["art-1"] = createArtifactRow({ type: "chart", content: "[1,2]\n" })
      render(<ArtifactPart part={createPart({ kind: "chart" })} />)
      const meta = screen.getByTestId("artifact-part-meta")
      expect(meta).not.toHaveTextContent(/line/)
      expect(meta).not.toHaveTextContent("v1")
    })
  })

  describe("body", () => {
    it("draws the preview at the compact density", () => {
      mockArtifacts["art-1"] = createArtifactRow({ type: "document", content: "# hi" })
      render(<ArtifactPart part={createPart()} />)
      expect(screen.getByTestId("artifact-preview")).toHaveAttribute("data-density", "compact")
    })

    it("switches between the preview and the source", () => {
      mockArtifacts["art-1"] = createArtifactRow({
        type: "document",
        content: "# hi",
        language: "markdown",
      })
      render(<ArtifactPart part={createPart()} />)
      const toggle = screen.getByTestId("artifact-part-view-toggle")
      expect(toggle).toHaveAttribute("aria-pressed", "false")

      fireEvent.click(toggle)
      expect(screen.queryByTestId("artifact-preview")).toBeNull()
      expect(screen.getByTestId("artifact-part-source")).toHaveTextContent("# hi")
      expect(screen.getByTestId("artifact-part-source")).toHaveAttribute(
        "data-language",
        "markdown"
      )
      expect(toggle).toHaveAttribute("aria-pressed", "true")

      fireEvent.click(toggle)
      expect(screen.getByTestId("artifact-preview")).toBeInTheDocument()
    })

    it("offers no source switch for code, whose preview already is the source", () => {
      mockArtifacts["art-1"] = createArtifactRow()
      render(<ArtifactPart part={createPart()} />)
      expect(screen.queryByTestId("artifact-part-view-toggle")).toBeNull()
    })

    it("lets a size-to-content body grow past its cap", () => {
      mockArtifacts["art-1"] = createArtifactRow({ type: "document", content: "# hi" })
      render(<ArtifactPart part={createPart()} />)
      const body = screen.getByTestId("artifact-part-body")
      expect(body.className).toContain("max-h-80")

      fireEvent.click(screen.getByTestId("artifact-part-enlarge"))
      expect(body).toHaveAttribute("data-expanded", "true")
      expect(body.className).toContain("max-h-[70vh]")
    })

    it("keeps an iframe preview in a fixed frame, which it enlarges", () => {
      mockArtifacts["art-1"] = createArtifactRow({ type: "html", content: "<p>x</p>" })
      render(<ArtifactPart part={createPart({ kind: "html" })} />)
      const body = screen.getByTestId("artifact-part-body")
      expect(body.className).toContain("h-72")

      fireEvent.click(screen.getByTestId("artifact-part-enlarge"))
      expect(body.className).toContain("h-[70vh]")
    })

    it("offers no Show more when nothing is clipped", () => {
      // jsdom lays nothing out, so no body is ever taller than its cap.
      mockArtifacts["art-1"] = createArtifactRow({ type: "document", content: "# hi" })
      render(<ArtifactPart part={createPart()} />)
      expect(screen.queryByTestId("artifact-part-show-more")).toBeNull()
    })

    it("offers Show more when the capped body clips its content, and it enlarges", () => {
      const scroll = jest.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900)
      const client = jest.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320)
      try {
        mockArtifacts["art-1"] = createArtifactRow({ type: "document", content: "# long" })
        render(<ArtifactPart part={createPart()} />)
        fireEvent.click(screen.getByTestId("artifact-part-show-more"))
        expect(screen.getByTestId("artifact-part-body")).toHaveAttribute("data-expanded", "true")
        // An enlarged body is no longer capped, so the fade goes away.
        expect(screen.queryByTestId("artifact-part-show-more")).toBeNull()
      } finally {
        scroll.mockRestore()
        client.mockRestore()
      }
    })

    it("hides the body-only actions while collapsed", () => {
      mockArtifacts["art-1"] = createArtifactRow({ type: "document", content: "# hi" })
      render(<ArtifactPart part={createPart({ defaultOpen: false })} />)
      expect(screen.queryByTestId("artifact-part-view-toggle")).toBeNull()
      expect(screen.queryByTestId("artifact-part-enlarge")).toBeNull()
    })
  })
})
