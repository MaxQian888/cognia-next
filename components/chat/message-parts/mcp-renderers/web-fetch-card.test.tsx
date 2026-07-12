/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

import { WebFetchCard } from "./web-fetch-card"

const part = (input?: unknown, output?: unknown): ToolUIPart =>
  ({
    type: "tool-web_fetch",
    toolCallId: "call",
    state: "output-available",
    input,
    output,
  }) as unknown as ToolUIPart

describe("WebFetchCard", () => {
  it("renders the fetched URL as an external link and previews the body", () => {
    render(
      <WebFetchCard part={part({ url: "https://example.com/doc" }, { content: "hello body" })} />
    )
    const link = screen.getByTestId("mcp-webfetch-url")
    expect(link).toHaveAttribute("href", "https://example.com/doc")
    // Routed through the shared ExternalLink → target=_blank on web.
    expect(link).toHaveAttribute("target", "_blank")
    expect(screen.getByTestId("mcp-webfetch-content")).toHaveTextContent("hello body")
  })

  it("returns null (generic body) when no URL is present", () => {
    const { container } = render(<WebFetchCard part={part({}, "x")} />)
    expect(container).toBeEmptyDOMElement()
  })
})
