/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

import { WriteCard } from "./write-card"

jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string }) => (
    <pre data-testid="code-block" data-language={language}>
      {code}
    </pre>
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
  it("renders the path and a language-aware content preview", () => {
    render(<WriteCard part={part({ file_path: "src/new.ts", content: "export const a = 1\n" })} />)
    expect(screen.getByTestId("mcp-write-path")).toHaveTextContent("src/new.ts")
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
})
