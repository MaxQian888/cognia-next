/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

import { FETCH_PREVIEW_CHARS, WebFetchResultCard, WebSearchResultCard } from "./result-cards"

const part = (output: unknown, input: unknown = {}): ToolUIPart =>
  ({ type: "tool-web_search", state: "output-available", input, output }) as unknown as ToolUIPart

describe("WebSearchResultCard", () => {
  it("renders query, provider badge, answer and result rows from the plugin payload", () => {
    render(
      <WebSearchResultCard
        part={part({
          ok: true,
          query: "cognia next",
          provider: "tavily",
          answer: "It is a desktop agent shell.",
          results: [
            {
              title: "Cognia",
              url: "https://cognia.example.com/docs",
              content: "Docs home",
              credibility: "high",
            },
            { title: "No link" },
          ],
        })}
      />
    )
    expect(screen.getByTestId("web-tools-search-card")).toBeInTheDocument()
    expect(screen.getByTestId("web-tools-search-query")).toHaveTextContent("cognia next")
    expect(screen.getByTestId("web-tools-search-card-badge")).toHaveTextContent("via tavily")
    expect(screen.getByTestId("web-tools-search-answer")).toHaveTextContent(
      "It is a desktop agent shell."
    )
    expect(screen.getByRole("link", { name: "Cognia" })).toHaveAttribute(
      "href",
      "https://cognia.example.com/docs"
    )
    expect(screen.getByText("cognia.example.com")).toBeInTheDocument()
    expect(screen.getByTestId("web-tools-search-credibility")).toHaveTextContent("high")
    expect(screen.getByText("No link")).toBeInTheDocument()
  })

  it("accepts a JSON string payload and shows the empty state", () => {
    render(
      <WebSearchResultCard part={part(JSON.stringify({ ok: true, query: "q", results: [] }))} />
    )
    expect(screen.getByText("No results.")).toBeInTheDocument()
  })

  it("shows the error state and declines unreadable payloads", () => {
    const { container: errorContainer } = render(
      <WebSearchResultCard part={part({ ok: false, error: "No provider configured" })} />
    )
    expect(
      errorContainer.querySelector('[data-testid="web-tools-search-error"]')
    ).toHaveTextContent("No provider configured")
    const { container } = render(<WebSearchResultCard part={part("not json at all")} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe("WebFetchResultCard", () => {
  it("renders title, url, status badge and a collapsible text preview", () => {
    const text = "x".repeat(FETCH_PREVIEW_CHARS + 50)
    render(
      <WebFetchResultCard
        part={part({
          ok: true,
          status: 200,
          url: "https://example.com/page",
          contentType: "text/html",
          title: "Example page",
          text,
        })}
      />
    )
    expect(screen.getByTestId("web-tools-fetch-title")).toHaveTextContent("Example page")
    expect(screen.getByTestId("web-tools-fetch-card-badge")).toHaveTextContent("HTTP 200")
    expect(screen.getByRole("link", { name: "https://example.com/page" })).toBeInTheDocument()
    expect(screen.getByText("text/html")).toBeInTheDocument()
    const pre = screen.getByTestId("web-tools-fetch-text")
    expect(pre.textContent?.length).toBe(FETCH_PREVIEW_CHARS + 1) // + ellipsis
    const toggle = screen.getByTestId("web-tools-fetch-toggle")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(toggle)
    expect(screen.getByTestId("web-tools-fetch-text").textContent).toBe(text)
    expect(screen.getByTestId("web-tools-fetch-toggle")).toHaveTextContent("Show less")
  })

  it("does not offer a toggle for short text and shows the error state", () => {
    render(
      <WebFetchResultCard
        part={part({ ok: true, status: 200, url: "https://a.b", text: "short" })}
      />
    )
    expect(screen.queryByTestId("web-tools-fetch-toggle")).toBeNull()
    render(
      <WebFetchResultCard part={part({ ok: false, error: "HTTP 500" }, { url: "https://a.b" })} />
    )
    expect(screen.getByTestId("web-tools-fetch-error")).toHaveTextContent("HTTP 500")
  })

  it("declines a payload with neither url nor error", () => {
    const { container } = render(<WebFetchResultCard part={part({ ok: true })} />)
    expect(container).toBeEmptyDOMElement()
  })
})
