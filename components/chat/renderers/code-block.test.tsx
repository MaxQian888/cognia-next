import { render } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CodeBlock } from "./code-block"
import { highlightCached, clearHighlightCache } from "@/lib/shiki/highlight-cache"

// Delegate to the real cache by default (so the seed tests use real shiki-mock
// highlighting) but keep `highlightCached` overridable for the reject path.
jest.mock("@/lib/shiki/highlight-cache", () => {
  const actual = jest.requireActual("@/lib/shiki/highlight-cache")
  return { ...actual, highlightCached: jest.fn(actual.highlightCached) }
})

// Shiki is mocked at the project level (jest.config.ts moduleNameMapper) —
// we don't need to mock it again. The mock returns synchronously so non-
// streaming renders complete their highlight pass before the assertion.

function renderInProvider(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

describe("CodeBlock", () => {
  it("renders the code text", () => {
    const { getByText } = renderInProvider(<CodeBlock code="const x = 1" language="ts" />)
    expect(getByText(/const x = 1/)).toBeInTheDocument()
  })

  it("renders the language label in the header", () => {
    const { container } = renderInProvider(<CodeBlock code="x = 1" language="python" />)
    expect(container.textContent).toContain("python")
  })

  it("falls back to plain-pre when no language is provided", () => {
    const { container } = renderInProvider(<CodeBlock code="just text" />)
    expect(container.querySelector("pre")).toBeTruthy()
  })

  describe("isStreaming short-circuit (Stage 4)", () => {
    it("renders without crashing when isStreaming is true", () => {
      const { container } = renderInProvider(
        <CodeBlock code="const partial = 'still streaming…'" language="ts" isStreaming />
      )
      // Plain-pre fallback path: a <pre> element is in the tree.
      expect(container.querySelector("pre")).toBeTruthy()
      expect(container.textContent).toContain("still streaming")
    })

    it("renders the same code path regardless of streaming flag (smoke test)", () => {
      const { container: streamingContainer } = renderInProvider(
        <CodeBlock code="line one" language="ts" isStreaming />
      )
      const { container: idleContainer } = renderInProvider(
        <CodeBlock code="line one" language="ts" isStreaming={false} />
      )
      // Both renders contain the same code text. The streaming path never
      // calls Shiki (verified by integration); the idle path does.
      expect(streamingContainer.textContent).toContain("line one")
      expect(idleContainer.textContent).toContain("line one")
    })

    it("defaults isStreaming to false (idle highlight path)", () => {
      const { container } = renderInProvider(<CodeBlock code="const y = 2" language="ts" />)
      expect(container.querySelector("pre")).toBeTruthy()
    })
  })

  describe("highlight cache (flash-free remount)", () => {
    beforeEach(() => {
      clearHighlightCache()
    })

    it("seeds the Shiki HTML synchronously from cache on mount", async () => {
      // Simulate a prior mount having already highlighted this snippet.
      await highlightCached("const cached = 1", "ts")

      // Line numbers OFF routes to the Shiki dangerouslySetInnerHTML path,
      // which only renders when `highlight` state is non-null. A synchronous
      // cache seed means it's present on the very first paint (no flash).
      const { container } = renderInProvider(
        <CodeBlock code="const cached = 1" language="ts" showLineNumbers={false} />
      )

      // The mock shiki emits one <pre> per theme (light + dark).
      expect(container.querySelectorAll("pre").length).toBeGreaterThanOrEqual(2)
      expect(container.innerHTML).toContain("const cached = 1")
    })

    it("falls back to plain-pre for a cold snippet not yet in cache", () => {
      const { container } = renderInProvider(
        <CodeBlock code="const cold = 2" language="ts" showLineNumbers={false} />
      )
      // Cold: no cached highlight, so the single plain-pre fallback renders.
      expect(container.querySelectorAll("pre").length).toBe(1)
      expect(container.textContent).toContain("const cold = 2")
    })

    it("keeps the plain-pre fallback when highlighting rejects", async () => {
      ;(highlightCached as jest.Mock).mockRejectedValueOnce(new Error("shiki boom"))

      const { container, findByText } = renderInProvider(
        <CodeBlock code="const broken = 3" language="ts" showLineNumbers={false} />
      )
      // The async reject resolves to setHighlight(null); the component must not
      // crash and keeps showing the code via the plain-pre fallback.
      await findByText(/const broken = 3/)
      expect(container.querySelector("pre")).toBeTruthy()
    })
  })
})
