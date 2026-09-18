/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

import { WikiReadCard } from "./wiki-read-card"

function part(output: unknown): ToolUIPart {
  return {
    type: "tool-wiki_read",
    toolCallId: "wr-call",
    state: "output-available",
    input: { slug: "hooks/overview" },
    output,
  } as unknown as ToolUIPart
}

describe("WikiReadCard", () => {
  it("renders sections expanded by default", () => {
    render(
      <WikiReadCard
        part={part({
          slug: "hooks/overview",
          title: "Hooks overview",
          sections: [
            { heading: "Events", body: "PreToolUse fires before the tool." },
            { heading: "Guards" },
          ],
        })}
      />
    )

    const sections = screen.getAllByTestId("mcp-wiki-read-section")
    expect(sections).toHaveLength(2)
    expect(screen.getByText("Events")).toBeInTheDocument()
    expect(screen.getByText("PreToolUse fires before the tool.")).toBeInTheDocument()
    expect(screen.getByText("Hide body")).toBeInTheDocument()
  })

  it("collapses the body behind the toggle", () => {
    render(<WikiReadCard part={part({ slug: "s", body: "article body" })} />)

    expect(screen.getByText("article body")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("mcp-wiki-read-toggle"))

    expect(screen.queryByText("article body")).not.toBeInTheDocument()
    expect(screen.getByText("Show body")).toBeInTheDocument()
  })

  it("falls back to the top-level body when no sections exist", () => {
    render(<WikiReadCard part={part({ slug: "s", body: "fallback body" })} />)
    expect(screen.getByText("fallback body")).toBeInTheDocument()
    expect(screen.queryByTestId("mcp-wiki-read-section")).not.toBeInTheDocument()
  })

  it("renders the explicit no-content state", () => {
    render(<WikiReadCard part={part({ slug: "empty" })} />)
    expect(screen.getByText("No content")).toBeInTheDocument()
  })

  it("renders nothing when the output is not an object", () => {
    const { container } = render(<WikiReadCard part={part("plain string")} />)
    expect(container).toBeEmptyDOMElement()
  })
})
