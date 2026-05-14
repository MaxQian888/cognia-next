/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { SourcesPart } from "./sources-part"
import type { SourcesPart as SourcesPartType } from "@/lib/claude/parts-extensions"

describe("SourcesPart", () => {
  it("returns null when no sources are present", () => {
    const { container } = render(<SourcesPart part={{ type: "sources", sources: [] }} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders one row per source with an origin badge", () => {
    const part: SourcesPartType = {
      type: "sources",
      sources: [
        {
          id: "a1",
          title: "Web result",
          url: "https://example.com",
          origin: "anthropic",
          snippet: "snip1",
        },
        { id: "t1", title: "Twin doc", origin: "twin-rag", score: 0.42 },
        { id: "f1", title: "Note 1", origin: "footnote" },
      ],
    }
    render(<SourcesPart part={part} defaultOpen />)

    const rows = screen.getAllByTestId("sources-part-row")
    expect(rows).toHaveLength(3)

    const origins = screen.getAllByTestId("sources-part-origin").map((n) => n.textContent)
    expect(origins).toEqual(["Web", "Twin", "Note"])

    expect(screen.getByTestId("sources-part-score")).toHaveTextContent("0.42")
  })

  it("wraps url sources in an anchor tag with rel=noopener", () => {
    const part: SourcesPartType = {
      type: "sources",
      sources: [{ id: "a1", title: "with url", url: "https://example.com", origin: "anthropic" }],
    }
    render(<SourcesPart part={part} defaultOpen />)
    const link = screen.getByRole("link")
    expect(link).toHaveAttribute("href", "https://example.com")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"))
  })

  it("omits anchor for sources without url", () => {
    const part: SourcesPartType = {
      type: "sources",
      sources: [{ id: "t1", title: "no-url", origin: "twin-rag" }],
    }
    render(<SourcesPart part={part} defaultOpen />)
    expect(screen.queryByRole("link")).toBeNull()
  })

  it("uses the count in the trigger label", () => {
    const part: SourcesPartType = {
      type: "sources",
      sources: [
        { id: "a", title: "1", origin: "anthropic" },
        { id: "b", title: "2", origin: "anthropic" },
      ],
    }
    render(<SourcesPart part={part} />)
    expect(screen.getByTestId("sources-part-trigger")).toHaveTextContent("Used 2 sources")
  })
})
