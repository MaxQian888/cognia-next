/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import { McpContentBlocksCard } from "./mcp-content-blocks-card"
import type { McpResultBlock } from "@/lib/claude/parts-extensions"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}))
jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code">{code}</pre>,
}))
jest.mock("@/components/chat/renderers/image-block", () => ({
  ImageBlock: ({ src }: { src: string }) => <img data-testid="img" src={src} alt="" />,
}))
jest.mock("@/components/chat/renderers/audio-block", () => ({
  AudioBlock: ({ src }: { src: string }) => <audio data-testid="audio" src={src} />,
}))
jest.mock("@/components/ai-elements/tool", () => ({
  ToolInput: ({ input }: { input: unknown }) => (
    <div data-testid="tool-input">{JSON.stringify(input)}</div>
  ),
}))

function partWith(blocks: McpResultBlock[], input?: unknown): ToolUIPart {
  return {
    type: "tool-mcp__srv__x",
    toolCallId: "c1",
    state: "output-available",
    input,
    mcpContent: blocks,
  } as unknown as ToolUIPart
}

describe("McpContentBlocksCard", () => {
  it("renders text blocks as markdown", () => {
    render(
      <McpContentBlocksCard
        part={partWith([{ type: "text", text: "hello **world**" }])}
        blocks={[{ type: "text", text: "hello **world**" }]}
      />
    )
    expect(screen.getByTestId("md").textContent).toBe("hello **world**")
  })

  it("renders an image block from MCP wire shape (data + mimeType)", () => {
    const blocks: McpResultBlock[] = [{ type: "image", data: "AAAA", mimeType: "image/png" }]
    render(<McpContentBlocksCard part={partWith(blocks)} blocks={blocks} />)
    expect(screen.getByTestId("img").getAttribute("src")).toBe("data:image/png;base64,AAAA")
  })

  it("renders an image block from Anthropic source shape", () => {
    const blocks: McpResultBlock[] = [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
    ]
    render(<McpContentBlocksCard part={partWith(blocks)} blocks={blocks} />)
    expect(screen.getByTestId("img").getAttribute("src")).toBe("data:image/jpeg;base64,BBBB")
  })

  it("renders an audio block inline", () => {
    const blocks: McpResultBlock[] = [{ type: "audio", data: "CCCC", mimeType: "audio/wav" }]
    render(<McpContentBlocksCard part={partWith(blocks)} blocks={blocks} />)
    expect(screen.getByTestId("audio").getAttribute("src")).toBe("data:audio/wav;base64,CCCC")
  })

  it("renders an embedded text resource as a code block", () => {
    const blocks: McpResultBlock[] = [
      { type: "resource", resource: { uri: "file:///a.py", text: "print(1)" } },
    ]
    render(<McpContentBlocksCard part={partWith(blocks)} blocks={blocks} />)
    expect(screen.getByTestId("code").textContent).toBe("print(1)")
    expect(screen.getByText("file:///a.py")).toBeInTheDocument()
  })

  it("renders a blob resource as a download link", () => {
    const blocks: McpResultBlock[] = [
      {
        type: "resource",
        resource: { uri: "x.bin", blob: "ZZZZ", mimeType: "application/octet-stream" },
      },
    ]
    render(<McpContentBlocksCard part={partWith(blocks)} blocks={blocks} />)
    const link = screen.getByTestId("mcp-block-resource") as HTMLAnchorElement
    expect(link.getAttribute("href")).toBe("data:application/octet-stream;base64,ZZZZ")
  })

  it("shows the tool input parameters above the blocks", () => {
    render(
      <McpContentBlocksCard
        part={partWith([{ type: "text", text: "ok" }], { q: "hi" })}
        blocks={[{ type: "text", text: "ok" }]}
      />
    )
    expect(screen.getByTestId("tool-input").textContent).toContain('"q":"hi"')
  })

  it("falls back to JSON for an unknown block type", () => {
    const blocks: McpResultBlock[] = [{ type: "weird", foo: 1 }]
    render(<McpContentBlocksCard part={partWith(blocks)} blocks={blocks} />)
    expect(screen.getByTestId("mcp-block-unknown").textContent).toContain('"foo": 1')
  })
})
