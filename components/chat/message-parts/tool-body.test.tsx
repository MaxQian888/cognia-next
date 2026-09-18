/**
 * @jest-environment jsdom
 */

import * as ReactForMocks from "react"
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

import { ToolBody } from "@/components/ai-elements/tool"

// The generic body is the last stop for unknown / MCP tools — this suite pins
// its compact chrome (slim `input`/`output` blocks, no prose-scale section
// cards). Leaf renderers are stubbed; `tool.tsx` and `tool-row.tsx` run real.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({
    code,
    language,
    headerTitle,
    compact,
  }: {
    code: string
    language?: string
    headerTitle?: React.ReactNode
    compact?: boolean
  }) =>
    ReactForMocks.createElement(
      "figure",
      {
        "data-testid": "code-block",
        "data-language": language ?? "",
        "data-compact": compact ? "true" : "false",
      },
      ReactForMocks.createElement("span", { "data-testid": "code-header" }, headerTitle),
      code
    ),
}))
jest.mock("@/components/chat/renderers/diff-block", () => ({
  DiffBlock: ({ content }: { content: string }) =>
    ReactForMocks.createElement("div", { "data-testid": "diff-block" }, content),
}))
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) =>
    ReactForMocks.createElement("div", { "data-testid": "md" }, content),
}))
jest.mock("@/components/error/error-parsed-view", () => ({
  ErrorParsedView: ({ rawError }: { rawError?: string }) =>
    ReactForMocks.createElement("div", { "data-testid": "error-parsed" }, rawError),
}))
jest.mock("@/hooks/ui", () => ({
  useCopy: () => ({ copied: false, copy: jest.fn(async () => true) }),
}))

function part(overrides: Record<string, unknown>): ToolUIPart {
  return {
    type: "tool-some_mcp_tool",
    toolCallId: "call-1",
    state: "output-available",
    ...overrides,
  } as unknown as ToolUIPart
}

describe("ToolBody (generic fallback)", () => {
  it("renders object input and object output as compact input/output blocks", () => {
    render(
      <ToolBody
        part={part({
          input: { url: "https://preview.acme.dev/42", wait: true },
          output: { ok: true },
        })}
      />
    )
    const inputBlock = screen.getByTestId("tool-input")
    expect(inputBlock.textContent).toContain("input")
    expect(inputBlock.textContent).toContain('"url": "https://preview.acme.dev/42"')
    const outputBlock = screen.getByTestId("tool-output")
    expect(outputBlock.textContent).toContain("output")
    expect(outputBlock.textContent).toContain('"ok": true')
  })

  it("routes a JSON string output to a compact CodeBlock labelled `output`", () => {
    render(
      <ToolBody
        part={part({
          input: { q: "x" },
          output: '{"ok":true,"issue":847}',
        })}
      />
    )
    const block = screen.getByTestId("code-block")
    expect(block.getAttribute("data-compact")).toBe("true")
    expect(block.getAttribute("data-language")).toBe("json")
    expect(screen.getByTestId("code-header").textContent).toBe("output")
    expect(block.textContent).toContain('"issue":847')
  })

  it("renders a markdown string output inside the bounded block", () => {
    render(<ToolBody part={part({ output: "**bold** summary" })} />)
    expect(screen.getByTestId("tool-output")).toBeTruthy()
    expect(screen.getByTestId("md").textContent).toBe("**bold** summary")
  })

  it("renders the error tone block with the parsed trace for a failed call", () => {
    render(
      <ToolBody part={part({ state: "output-error", input: { a: 1 }, errorText: "boom\nstack" })} />
    )
    const errorBlock = screen.getByTestId("tool-error")
    expect(errorBlock.textContent).toContain("errorLabel")
    expect(screen.getByTestId("error-parsed").textContent).toContain("boom")
    // The input block still renders — the arguments that failed stay visible.
    expect(screen.getByTestId("tool-input").textContent).toContain('"a": 1')
  })

  it("renders an Edit tool's input as the proposed-change diff", () => {
    render(
      <ToolBody
        part={part({
          type: "tool-Edit",
          input: { file_path: "a.ts", old_string: "old()", new_string: "new()" },
          output: "done",
        })}
      />
    )
    expect(screen.getByText("proposedChange")).toBeTruthy()
    expect(screen.getByTestId("diff-block").textContent).toContain("-old()")
    expect(screen.getByTestId("diff-block").textContent).toContain("+new()")
  })
})
