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

  it("renders a degraded notice when twinDegraded is set even with zero sources", () => {
    const { container } = render(
      <SourcesPart part={{ type: "sources", sources: [], twinDegraded: true }} />
    )
    expect(container.firstChild).not.toBeNull()
    expect(screen.getByTestId("sources-part-degraded")).toBeTruthy()
  })

  it("renders the degraded notice alongside retrieved sources", () => {
    const part: SourcesPartType = {
      type: "sources",
      sources: [{ id: "t1", title: "doc.md", origin: "twin-rag" }],
      twinDegraded: true,
    }
    render(<SourcesPart part={part} defaultOpen />)
    expect(screen.getByTestId("sources-part-degraded")).toBeTruthy()
    expect(screen.getByTestId("sources-part-section-twin-rag")).toBeTruthy()
  })

  it("renders no degraded notice on a healthy turn", () => {
    const part: SourcesPartType = {
      type: "sources",
      sources: [{ id: "t1", title: "doc.md", origin: "twin-rag" }],
    }
    render(<SourcesPart part={part} defaultOpen />)
    expect(screen.queryByTestId("sources-part-degraded")).toBeNull()
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

    // Sections are partitioned: twin-rag first, then twin-style (none here),
    // then other origins (anthropic + footnote) in input order.
    const origins = screen.getAllByTestId("sources-part-origin").map((n) => n.textContent)
    expect(origins).toEqual(["Twin", "Web", "Note"])

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

  it("renders a Style badge for twin-style origin items", () => {
    const part: SourcesPartType = {
      type: "sources",
      sources: [{ id: "s1", title: "tone", origin: "twin-style", snippet: "concise" }],
    }
    render(<SourcesPart part={part} defaultOpen />)
    expect(screen.getByTestId("sources-part-origin")).toHaveTextContent("Style")
  })

  it("renders reusable Agent Knowledge Base citations in their own section", () => {
    render(
      <SourcesPart
        part={{
          type: "sources",
          sources: [
            {
              id: "kb-1",
              title: "Product / Guide",
              origin: "agent-knowledge-base",
              snippet: "Grounded context",
            },
          ],
        }}
      />
    )

    expect(screen.getByTestId("sources-part-section-agent-knowledge-base")).toBeTruthy()
    expect(screen.getByText("Agent KB")).toBeTruthy()
  })

  it("renders project knowledge in its own source section", () => {
    render(
      <SourcesPart
        part={{
          type: "sources",
          sources: [
            {
              id: "project-1",
              title: "ARCHITECTURE.md",
              origin: "project-knowledge",
              snippet: "Workspace context",
            },
          ],
        }}
      />
    )

    expect(screen.getByTestId("sources-part-section-project-knowledge")).toBeTruthy()
    expect(screen.getByText("Project")).toBeTruthy()
  })

  it("renders a View source link for twin-rag items with chunkRef", () => {
    const part: SourcesPartType = {
      type: "sources",
      sources: [
        {
          id: "t1",
          title: "doc.md",
          origin: "twin-rag",
          chunkRef: { twinId: "twin_a", sourceId: "src1", chunkId: "v1" },
        },
      ],
    }
    render(<SourcesPart part={part} defaultOpen />)
    const link = screen.getByTestId("sources-part-view-source")
    const href = link.getAttribute("href") ?? ""
    expect(href).toContain("/twin")
    expect(href).toContain("twinId=twin_a")
    expect(href).toContain("tab=sources")
    expect(href).toContain("sourceId=src1")
    expect(href).toContain("chunkId=v1")
  })

  it("groups retrieved chunks and style samples into labeled sections", () => {
    const part: SourcesPartType = {
      type: "sources",
      sources: [
        { id: "t1", title: "doc.md", origin: "twin-rag" },
        { id: "s1", title: "tone", origin: "twin-style" },
      ],
    }
    render(<SourcesPart part={part} defaultOpen />)
    expect(screen.getByTestId("sources-part-section-twin-rag")).toBeTruthy()
    expect(screen.getByTestId("sources-part-section-twin-style")).toBeTruthy()
  })

  it("defaults to open when the only sources are twin-*", () => {
    const part: SourcesPartType = {
      type: "sources",
      sources: [{ id: "t1", title: "doc.md", origin: "twin-rag" }],
    }
    render(<SourcesPart part={part} />)
    // CollapsibleContent renders only when open; presence of the section
    // header confirms the strip auto-expanded.
    expect(screen.getByTestId("sources-part-section-twin-rag")).toBeTruthy()
  })

  it("defaults to closed when a non-twin source is mixed in", () => {
    const part: SourcesPartType = {
      type: "sources",
      sources: [
        { id: "t1", title: "doc.md", origin: "twin-rag" },
        { id: "a1", title: "web", origin: "anthropic", url: "https://x" },
      ],
    }
    render(<SourcesPart part={part} />)
    // Mixed origin → caller decides; default-open heuristic does not fire.
    expect(screen.queryByTestId("sources-part-section-twin-rag")).toBeNull()
  })

  it("renders recalled memories in a dedicated memory section", () => {
    const part: SourcesPartType = {
      type: "sources",
      sources: [{ id: "memory-m1", title: "prefers pnpm", origin: "memory", score: 0.8 }],
    }
    render(<SourcesPart part={part} defaultOpen />)
    expect(screen.getByTestId("sources-part-section-memory")).toBeTruthy()
    expect(screen.getByText("prefers pnpm")).toBeTruthy()
  })

  it("auto-expands when the only sources are recalled memories", () => {
    const part: SourcesPartType = {
      type: "sources",
      sources: [{ id: "memory-m1", title: "prefers pnpm", origin: "memory" }],
    }
    render(<SourcesPart part={part} />)
    expect(screen.getByTestId("sources-part-section-memory")).toBeTruthy()
  })
})
