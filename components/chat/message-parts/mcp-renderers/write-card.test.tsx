/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import type { ToolUIPart } from "ai"

const openEditInWorkbenchReview = jest.fn()
jest.mock("@/lib/files/edit-review-bridge", () => ({
  canOfferWorkbenchReview: () => true,
  openEditInWorkbenchReview: (args: unknown) => openEditInWorkbenchReview(args),
}))

import { WriteCard } from "./write-card"

jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({
    code,
    language,
    headerTitle,
  }: {
    code: string
    language?: string
    headerTitle?: React.ReactNode
  }) => (
    <div>
      {headerTitle}
      <pre data-testid="code-block" data-language={language}>
        {code}
      </pre>
    </div>
  ),
}))

const part = (input?: unknown): ToolUIPart =>
  ({
    type: "tool-write",
    toolCallId: "call",
    state: "output-available",
    input,
    output: undefined,
  }) as unknown as ToolUIPart

describe("WriteCard", () => {
  it("offers a workbench-review action that routes the written file", () => {
    openEditInWorkbenchReview.mockClear()
    render(
      <WriteCard sessionId="s1" part={part({ file_path: "/repo/src/new.ts", content: "a\n" })} />
    )
    fireEvent.click(screen.getByTestId("mcp-open-in-review"))
    expect(openEditInWorkbenchReview).toHaveBeenCalledWith({
      sessionId: "s1",
      absolutePath: "/repo/src/new.ts",
    })
  })

  it("renders the path and a language-aware content preview", () => {
    render(<WriteCard part={part({ file_path: "src/new.ts", content: "export const a = 1\n" })} />)
    expect(screen.getByTestId("mcp-write-path")).toHaveTextContent("new.ts")
    expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "typescript")
  })

  it("clips very large content and says so", () => {
    render(<WriteCard part={part({ file_path: "big.md", content: "x".repeat(10_000) })} />)
    const code = screen.getByTestId("code-block")
    expect(code.textContent?.length).toBeLessThan(10_000)
  })

  it("accepts the legacy `path` field and falls back to text for unknown extensions", () => {
    render(<WriteCard part={part({ path: "notes.unknownext", content: "plain" })} />)
    expect(screen.getByTestId("mcp-write-path")).toHaveTextContent("notes.unknownext")
    expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "text")
  })

  it("returns null without a path or content", () => {
    const { container: noPath } = render(<WriteCard part={part({ content: "x" })} />)
    expect(noPath).toBeEmptyDOMElement()
    const { container: noContent } = render(<WriteCard part={part({ file_path: "a.ts" })} />)
    expect(noContent).toBeEmptyDOMElement()
  })

  it("clamps a many-line write to the preview budget and reveals on demand", () => {
    const content = Array.from({ length: 300 }, (_, i) => `L${i}`).join("\n")
    render(<WriteCard part={part({ file_path: "big.txt", content })} />)
    const code = screen.getByTestId("code-block")
    expect(code.textContent).toContain("L119")
    expect(code.textContent).not.toContain("L120")
    const note = screen.getByTestId("mcp-write-clamped")
    expect(note).toHaveTextContent("Showing the first 120 of 300")
    expect(note).toHaveTextContent("full content is written to disk")
    fireEvent.click(screen.getByTestId("mcp-write-clamped-show-all"))
    expect(screen.getByTestId("code-block").textContent).toContain("L299")
  })

  it("reports the char-driven clip in characters, not lines", () => {
    render(<WriteCard part={part({ file_path: "min.js", content: "x".repeat(10_000) })} />)
    expect(screen.getByTestId("mcp-write-clamped")).toHaveTextContent(
      "Showing the first 4,000 of 10,000"
    )
  })
})
