/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { ErrorParsedView } from "./error-parsed-view"
import { useFileViewerStore } from "@/stores/file-viewer/file-viewer-store"
import { useProjectStore } from "@/stores/project/project-store"

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

  it("preserves leading whitespace in multi-line continuation log nodes", () => {
    render(
      <ErrorParsedView
        parsed={{
          nodes: [{ kind: "log", content: "    at /app/server.js:42", level: "error" }],
          parsed: true,
        }}
        rawText="x"
      />
    )
    // Indented continuation lines (stack frames under an ERROR line) must keep
    // their indentation rather than collapsing like default HTML whitespace.
    expect(screen.getByText(/at \/app\/server\.js:42/)).toHaveClass("whitespace-pre-wrap")
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

  it("renders a JSON node as a tree from its value, including nested keys", () => {
    render(
      <ErrorParsedView
        parsed={{
          nodes: [
            {
              kind: "json",
              content: "{2 keys}",
              value: { msg: "boom", nested: { n: 42 } },
            },
          ],
          parsed: true,
        }}
        rawText="{}"
      />
    )
    expect(screen.getByText(/boom/)).toBeInTheDocument()
    // Nested object values render too — the old children round-trip dropped them.
    expect(screen.getByText("42")).toBeInTheDocument()
  })

  it("renders a JSON node without a value as inline content", () => {
    render(
      <ErrorParsedView
        parsed={{ nodes: [{ kind: "json", content: "{0 keys}" }], parsed: true }}
        rawText="{}"
      />
    )
    expect(screen.getByText("{0 keys}")).toBeInTheDocument()
  })

  it("renders a stack node as clickable frames", () => {
    render(
      <ErrorParsedView
        parsed={{
          nodes: [
            {
              kind: "stack",
              content: "trace",
              frames: [{ fn: "handler", file: "/app/x.ts", line: 4, col: 2 }],
            },
          ],
          parsed: true,
        }}
        rawText="trace"
      />
    )
    expect(screen.getByRole("button", { name: /\/app\/x\.ts/ })).toBeInTheDocument()
  })

  it("preserves unknown stack-frame coordinates when opening a file", () => {
    useFileViewerStore.setState({ open: false, request: null, failure: null })
    useProjectStore.setState({
      projects: [{ id: "p1", name: "app", roots: [{ id: "r1", path: "/app", primary: true }] }],
    } as never)
    render(
      <ErrorParsedView
        parsed={{
          nodes: [
            {
              kind: "stack",
              content: "trace",
              frames: [{ fn: "handler", file: "/app/x.ts", line: null, col: null }],
            },
          ],
          parsed: true,
        }}
        rawText="trace"
      />
    )

    fireEvent.click(screen.getByRole("button", { name: /\/app\/x\.ts/ }))

    // A stack frame with no coordinates still opens the file; the path is
    // resolved against the open workspace first, so the viewer gets a confined
    // `{ root, relPath }` rather than a bare absolute path.
    expect(useFileViewerStore.getState()).toMatchObject({
      open: true,
      request: { root: "/app", relPath: "x.ts", line: null, column: null },
    })
  })

  it("handles nodes missing optional fields and every statusCode tier", () => {
    render(
      <ErrorParsedView
        parsed={{
          nodes: [
            { kind: "log", content: "no level here" },
            { kind: "exitCode", content: "code only" },
            { kind: "ansi", content: "plain ansi" },
            { kind: "stack", content: "no frames" },
            { kind: "statusCode", content: "200", status: 200 },
            { kind: "statusCode", content: "301", status: 301 },
            { kind: "statusCode", content: "404 bare", status: 404 },
            { kind: "statusCode", content: "500", status: 500 },
          ],
          parsed: true,
        }}
        rawText="x"
      />
    )
    expect(screen.getByText("no level here")).toBeInTheDocument()
    expect(screen.getByText("plain ansi")).toBeInTheDocument()
    expect(screen.getByText("no frames")).toBeInTheDocument()
    expect(screen.getByText("200")).toBeInTheDocument()
    expect(screen.getByText("500")).toBeInTheDocument()
  })

  it("renders an exit-code node as a badge", () => {
    render(
      <ErrorParsedView
        parsed={{
          nodes: [
            { kind: "exitCode", content: "exit 0", exitCode: 0 },
            { kind: "exitCode", content: "exit 1", exitCode: 1 },
            { kind: "exitCode", content: "signal 137", exitCode: 137 },
          ],
          parsed: true,
        }}
        rawText="exit"
      />
    )
    expect(screen.getByText("exit 0")).toBeInTheDocument()
    expect(screen.getByText("exit 1")).toBeInTheDocument()
    expect(screen.getByText("signal 137")).toBeInTheDocument()
  })

  it("renders a category node with a localized label and hint", () => {
    render(
      <ErrorParsedView
        parsed={{
          nodes: [{ kind: "category", content: "ECONNREFUSED", category: "connectionRefused" }],
          parsed: true,
        }}
        rawText="ECONNREFUSED"
      />
    )
    expect(screen.getByText("Connection refused")).toBeInTheDocument()
    expect(screen.getByText(/server isn't accepting connections/i)).toBeInTheDocument()
  })

  it("renders a non-destructive (warning) category with the fallback when the id is unknown", () => {
    const { rerender } = render(
      <ErrorParsedView
        parsed={{ nodes: [{ kind: "category", content: "x", category: "timeout" }], parsed: true }}
        rawText="x"
      />
    )
    expect(screen.getByText("Request timed out")).toBeInTheDocument()

    // Unknown category id → label falls back to node.content, no hint, default icon.
    rerender(
      <ErrorParsedView
        parsed={{
          nodes: [{ kind: "category", content: "mystery failure", category: "nope" }],
          parsed: true,
        }}
        rawText="mystery failure"
      />
    )
    expect(screen.getByText("mystery failure")).toBeInTheDocument()
  })

  it("renders a statusCode node with its category hint", () => {
    render(
      <ErrorParsedView
        parsed={{
          nodes: [{ kind: "statusCode", content: "429", status: 429, category: "rateLimited" }],
          parsed: true,
        }}
        rawText="429"
      />
    )
    expect(screen.getByText("429")).toBeInTheDocument()
    expect(screen.getByText(/rate limit/i)).toBeInTheDocument()
  })

  it("parses a raw error string itself when no `parsed` prop is given", () => {
    render(<ErrorParsedView rawError="Error: connect ECONNREFUSED 127.0.0.1:3000" />)
    expect(screen.getByText("Connection refused")).toBeInTheDocument()
  })

  it("normalizes a non-string error before parsing (no [object Object])", () => {
    render(
      <ErrorParsedView
        rawError={{ type: "error", error: { type: "rate_limit_error", message: "slow down" } }}
      />
    )
    // The Anthropic envelope is recognised → 429 status badge.
    expect(screen.getByText(/429/)).toBeInTheDocument()
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument()
  })

  it("omits the raw/parsed toggle for unrecognised plain text", () => {
    render(<ErrorParsedView rawError="just some plain text" fallback="fallback" />)
    expect(screen.getByText("just some plain text")).toBeInTheDocument()
    expect(screen.queryByTestId("error-parsed-toggle")).not.toBeInTheDocument()
  })
})
