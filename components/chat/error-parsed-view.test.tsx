/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { ErrorParsedView } from "./error-parsed-view"

describe("ErrorParsedView", () => {
  it("renders text nodes", () => {
    render(
      <ErrorParsedView
        parsed={{ nodes: [{ kind: "text", content: "hello" }], parsed: true }}
        rawText="hello"
      />
    )
    expect(screen.getByText("hello")).toBeInTheDocument()
  })

  it("renders URL nodes as links", () => {
    render(
      <ErrorParsedView
        parsed={{
          nodes: [{ kind: "url", content: "https://example.com", href: "https://example.com" }],
          parsed: true,
        }}
        rawText="https://example.com"
      />
    )
    expect(screen.getByRole("link", { name: /example\.com/ })).toHaveAttribute(
      "href",
      "https://example.com"
    )
  })

  it("renders path nodes as clickable buttons", () => {
    render(
      <ErrorParsedView
        parsed={{
          nodes: [
            {
              kind: "path",
              content: "src/foo.ts:1:2",
              href: "src/foo.ts",
              line: 1,
              column: 2,
            },
          ],
          parsed: true,
        }}
        rawText="src/foo.ts:1:2"
      />
    )
    expect(screen.getByRole("button", { name: /src\/foo\.ts/ })).toBeInTheDocument()
  })

  it("renders log nodes", () => {
    render(
      <ErrorParsedView
        parsed={{
          nodes: [{ kind: "log", content: "ERROR: fail", level: "error" }],
          parsed: true,
        }}
        rawText="ERROR: fail"
      />
    )
    expect(screen.getByText("ERROR: fail")).toBeInTheDocument()
  })

  it("toggles to raw view on button click", () => {
    render(
      <ErrorParsedView
        parsed={{ nodes: [{ kind: "text", content: "parsed" }], parsed: true }}
        rawText="raw text here"
      />
    )
    // Default: parsed view
    expect(screen.getByText("parsed")).toBeInTheDocument()

    // Click toggle
    fireEvent.click(screen.getByTestId("error-parsed-toggle"))
    expect(screen.getByText("raw text here")).toBeInTheDocument()

    // Click back
    fireEvent.click(screen.getByTestId("error-parsed-toggle"))
    expect(screen.getByText("parsed")).toBeInTheDocument()
  })

  it("renders ANSI nodes as coloured segments", () => {
    render(
      <ErrorParsedView
        parsed={{
          nodes: [
            {
              kind: "ansi",
              content: "Error here",
              segments: [
                { text: "Error", className: "text-red-500" },
                { text: " here", className: undefined },
              ],
            },
          ],
          parsed: true,
        }}
        rawText="Error here"
      />
    )
    const colored = screen.getByText("Error")
    expect(colored).toHaveClass("text-red-500")
    expect(screen.getByText(/here/)).toBeInTheDocument()
  })
})
