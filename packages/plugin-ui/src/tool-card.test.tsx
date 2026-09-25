import { render, renderHook, screen } from "@testing-library/react"

import { parseToolOutput, ToolCard, useParsedToolOutput } from "./tool-card"

describe("ToolCard", () => {
  it("renders themed card chrome, badge, action, and content", () => {
    render(
      <ToolCard title="Search" badge="3" action={<button type="button">Open</button>} testId="card">
        Result
      </ToolCard>
    )
    expect(screen.getByTestId("card")).toHaveAttribute("data-slot", "plugin-tool-card")
    expect(screen.getByTestId("card-badge")).toHaveTextContent("3")
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument()
    expect(screen.getByText("Result")).toBeInTheDocument()
  })

  it("renders without the optional badge and action", () => {
    render(<ToolCard title="Search">Result</ToolCard>)
    const card = screen.getByText("Search").closest("[data-slot=plugin-tool-card]")
    expect(card).not.toBeNull()
    expect(card?.querySelector("[data-slot=plugin-tool-card-actions]")?.childElementCount).toBe(0)
  })

  it("merges a caller className onto the card", () => {
    render(
      <ToolCard title="Search" className="my-4" testId="card">
        Result
      </ToolCard>
    )
    const tokens = screen.getByTestId("card").className.split(/\s+/)
    expect(tokens).toContain("my-4")
    expect(tokens).not.toContain("my-2")
  })

  /**
   * A tool result renders in a 375px chat column on a phone. jsdom does no
   * layout, so the overflow contract is pinned by the classes that implement
   * it: remove any one of them and a long title / wide action row / wide
   * result pushes the whole chat sideways.
   */
  describe("narrow-screen overflow", () => {
    function renderCard() {
      render(
        <ToolCard
          title="A very long tool title that cannot possibly fit beside its actions on a phone"
          badge="12"
          action={<button type="button">Open</button>}
          testId="card"
        >
          <pre>{"x".repeat(400)}</pre>
        </ToolCard>
      )
      const card = screen.getByTestId("card")
      const slot = (name: string) =>
        (card.querySelector(`[data-slot=${name}]`) as HTMLElement).className.split(/\s+/)
      return { card: card.className.split(/\s+/), slot }
    }

    it("lets the card shrink inside a flex or grid parent", () => {
      expect(renderCard().card).toContain("min-w-0")
    })

    it("truncates the title instead of widening the header", () => {
      const { slot } = renderCard()
      expect(slot("plugin-tool-card-title")).toEqual(
        expect.arrayContaining(["min-w-0", "truncate"])
      )
      expect(slot("plugin-tool-card-header")).toEqual(
        expect.arrayContaining(["flex", "min-w-0", "flex-wrap"])
      )
    })

    it("wraps the actions rather than overflowing", () => {
      const { slot } = renderCard()
      expect(slot("plugin-tool-card-actions")).toEqual(
        expect.arrayContaining(["flex", "flex-wrap", "min-w-0", "max-w-full"])
      )
    })

    it("scrolls a wide body sideways inside the card", () => {
      const { slot } = renderCard()
      expect(slot("plugin-tool-card-body")).toEqual(
        expect.arrayContaining(["min-w-0", "overflow-x-auto"])
      )
    })

    it("keeps the full title text in the DOM for assistive tech", () => {
      renderCard()
      expect(
        screen.getByText(
          "A very long tool title that cannot possibly fit beside its actions on a phone"
        )
      ).toHaveAttribute("data-slot", "plugin-tool-card-title")
    })
  })
})

describe("tool output parsing", () => {
  it("accepts objects and JSON strings while rejecting invalid output", () => {
    expect(parseToolOutput({ ok: true })).toEqual({ ok: true })
    expect(parseToolOutput('{"ok":true}')).toEqual({ ok: true })
    expect(parseToolOutput("not-json")).toBeNull()
    expect(parseToolOutput(" ")).toBeNull()
  })

  it("exposes a memoized typed hook", () => {
    const { result, rerender } = renderHook(
      ({ output }) => useParsedToolOutput<{ count: number }>(output),
      {
        initialProps: { output: '{"count":2}' as unknown },
      }
    )
    expect(result.current).toEqual({ count: 2 })
    rerender({ output: null })
    expect(result.current).toBeNull()
  })
})
