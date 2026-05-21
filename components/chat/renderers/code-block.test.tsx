import { render } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CodeBlock } from "./code-block"

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
})
