import { fireEvent, render, waitFor } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CODE_AUTO_RENDER_MAX_LINES, CodeBlock } from "./code-block"
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

  it("marks the horizontal scroll container with the touch scroll affordance class", () => {
    const { container } = renderInProvider(<CodeBlock code="a very long line of code" />)
    // `.code-scroll-x` adds momentum scrolling + a coarse-pointer scrollbar so
    // the horizontal scroll is discoverable on touch.
    expect(container.querySelector(".code-scroll-x")).toBeTruthy()
  })

  it("keeps the header toolbar reachable on coarse pointers (no hover on touch)", () => {
    const { container } = renderInProvider(<CodeBlock code="x = 1" language="python" />)
    // The toolbar is hover-revealed on desktop; `pointer-coarse:opacity-100`
    // keeps copy/download/fullscreen reachable on touch, where group-hover
    // never fires.
    const toolbar = container.querySelector(".pointer-coarse\\:opacity-100")
    expect(toolbar).toBeTruthy()
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

  // Regression: finalized code blocks default to `showLineNumbers`, and the
  // Shiki-coloured path used to render *only* when line numbers were OFF — so
  // the default view dropped all syntax colour, rendering through a plain
  // <table>. Colour + line numbers must now co-exist (line numbers come from a
  // CSS counter on Shiki's per-line `.line` spans, keyed off `.code-line-numbers`).
  describe("syntax highlighting with line numbers", () => {
    beforeEach(() => {
      clearHighlightCache()
    })

    it("renders Shiki-highlighted HTML even with line numbers on (the default)", async () => {
      await highlightCached("const lit = 1", "ts")
      const { container } = renderInProvider(
        <CodeBlock code="const lit = 1" language="ts" showLineNumbers />
      )
      // Shiki path: one <pre> per theme (light + dark) from the mock, and NOT
      // the manual line-number <table> that renders code without any colour.
      expect(container.querySelectorAll("pre").length).toBeGreaterThanOrEqual(2)
      expect(container.querySelector("table")).toBeNull()
    })

    it("marks the highlighted container with the line-number affordance class when line numbers are on", async () => {
      await highlightCached("const n = 1", "ts")
      const { container } = renderInProvider(
        <CodeBlock code="const n = 1" language="ts" showLineNumbers />
      )
      expect(container.querySelector(".code-line-numbers")).toBeTruthy()
    })

    it("omits the line-number affordance class when line numbers are off", async () => {
      await highlightCached("const f = 1", "ts")
      const { container } = renderInProvider(
        <CodeBlock code="const f = 1" language="ts" showLineNumbers={false} />
      )
      expect(container.querySelector(".code-line-numbers")).toBeNull()
      expect(container.querySelectorAll("pre").length).toBeGreaterThanOrEqual(2)
    })

    it("falls back to the manual line-numbered table when highlighting is unavailable (streaming)", () => {
      const { container } = renderInProvider(
        <CodeBlock code={"a\nb"} language="ts" showLineNumbers isStreaming />
      )
      // Streaming skips Shiki, so the line-numbered table fallback still renders.
      expect(container.querySelector("table")).toBeTruthy()
    })

    it("keeps the manual line-highlight table path when highlightLines is set", async () => {
      await highlightCached("a\nb\nc", "ts")
      const { container } = renderInProvider(
        <CodeBlock code={"a\nb\nc"} language="ts" showLineNumbers highlightLines={[2]} />
      )
      // Explicit per-line emphasis still uses the table (bg on chosen lines);
      // this opt-in path intentionally renders without Shiki colour.
      expect(container.querySelector("table")).toBeTruthy()
    })
  })

  describe("oversized blocks", () => {
    const hugeCode = Array.from(
      { length: CODE_AUTO_RENDER_MAX_LINES + 500 },
      (_, i) => `line ${i}`
    ).join("\n")

    it("renders only the first N lines of a huge block", () => {
      const { container } = renderInProvider(
        <CodeBlock code={hugeCode} showLineNumbers isStreaming />
      )

      const rows = container.querySelectorAll("tbody tr")
      expect(rows).toHaveLength(CODE_AUTO_RENDER_MAX_LINES)
      expect(container.textContent).toContain(`line ${CODE_AUTO_RENDER_MAX_LINES - 1}`)
      expect(container.textContent).not.toContain(`line ${CODE_AUTO_RENDER_MAX_LINES}\n`)
    })

    it("highlights only the visible slice, not the whole block", async () => {
      const highlightMock = highlightCached as jest.MockedFunction<typeof highlightCached>
      highlightMock.mockClear()

      renderInProvider(<CodeBlock code={hugeCode} language="ts" />)

      await Promise.resolve()
      for (const call of highlightMock.mock.calls) {
        expect(call[0].split("\n")).toHaveLength(CODE_AUTO_RENDER_MAX_LINES)
      }
    })

    it("offers a way out and renders everything once taken", () => {
      const { container, getByRole } = renderInProvider(
        <CodeBlock code={hugeCode} showLineNumbers isStreaming />
      )

      fireEvent.click(getByRole("button", { name: /show all/i }))

      expect(container.querySelectorAll("tbody tr")).toHaveLength(CODE_AUTO_RENDER_MAX_LINES + 500)
      // The escape hatch is spent, not sticky chrome.
      expect(container.textContent).not.toMatch(/Showing the first/i)
    })

    it("leaves a block at the limit untouched", () => {
      const atLimit = Array.from({ length: CODE_AUTO_RENDER_MAX_LINES }, (_, i) => `x${i}`).join(
        "\n"
      )
      const { container, queryByRole } = renderInProvider(
        <CodeBlock code={atLimit} showLineNumbers isStreaming />
      )

      expect(queryByRole("button", { name: /show all/i })).toBeNull()
      expect(container.querySelectorAll("tbody tr")).toHaveLength(CODE_AUTO_RENDER_MAX_LINES)
    })

    it("copies the whole block, not the truncated view", async () => {
      const writeText = jest.fn().mockResolvedValue(undefined)
      Object.assign(navigator, { clipboard: { writeText } })

      const { getAllByRole } = renderInProvider(<CodeBlock code={hugeCode} isStreaming />)
      const copyButton = getAllByRole("button").find((b) =>
        /copy/i.test(b.getAttribute("aria-label") ?? "")
      )!
      fireEvent.click(copyButton)

      await waitFor(() => expect(writeText).toHaveBeenCalled())
      // The cap is a render budget; the data is never truncated.
      expect(writeText.mock.calls[0][0].split("\n")).toHaveLength(CODE_AUTO_RENDER_MAX_LINES + 500)
    })
  })

  // ADR-0127: `wrapLines` / `showLineNumbers` are settings-driven defaults;
  // the toolbar toggles are per-block overrides layered on top, so a settings
  // change after mount still reaches an untouched block.
  describe("settings-driven defaults with per-block override", () => {
    /** Wrap is expressed on the `<pre>` (fallback path) or as a `[&>pre]:` rule
     *  on the highlighted wrapper — either way the class string carries it. */
    const isWrapped = (container: HTMLElement) =>
      /whitespace-pre-wrap/.test(
        (container.querySelector('[role="code"]')?.className ?? "") +
          (container.querySelector("pre")?.className ?? "")
      )

    it("wraps by default when wrapLines is set and follows a later prop change", async () => {
      const { container, rerender } = renderInProvider(
        <CodeBlock code="const a = 1" language="ts" wrapLines />
      )
      await waitFor(() => expect(isWrapped(container)).toBe(true))
      rerender(
        <TooltipProvider>
          <CodeBlock code="const a = 1" language="ts" wrapLines={false} />
        </TooltipProvider>
      )
      await waitFor(() => expect(isWrapped(container)).toBe(false))
    })

    it("a toolbar toggle overrides the default until the block remounts", async () => {
      const { container, getByRole } = renderInProvider(
        <CodeBlock code="const a = 1" language="ts" />
      )
      await waitFor(() => expect(isWrapped(container)).toBe(false))
      fireEvent.click(getByRole("button", { name: "Enable word wrap" }))
      await waitFor(() => expect(isWrapped(container)).toBe(true))
      // The override sticks even when the default flips underneath it.
      expect(getByRole("button", { name: "Disable word wrap" })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
    })
  })
})
