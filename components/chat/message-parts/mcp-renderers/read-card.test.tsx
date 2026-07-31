/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import { ReadCard } from "./read-card"
import type { McpResultBlock } from "@/lib/claude/parts-extensions"

jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string }) => (
    <pre data-testid="code" data-language={language}>
      {code}
    </pre>
  ),
}))
jest.mock("@/components/chat/renderers/image-block", () => ({
  ImageBlock: ({ src, alt }: { src: string; alt?: string }) => (
    <img data-testid="img" src={src} alt={alt ?? ""} />
  ),
}))

function readPart(overrides: Partial<ToolUIPart> & { mcpContent?: McpResultBlock[] }): ToolUIPart {
  return {
    type: "tool-Read",
    toolCallId: "c1",
    state: "output-available",
    input: { file_path: "/tmp/a.ts" },
    ...overrides,
  } as unknown as ToolUIPart
}

describe("ReadCard", () => {
  it("renders the file contents as a code block for a text read", () => {
    render(<ReadCard part={readPart({ output: "const a = 1" })} />)
    expect(screen.getByTestId("code").textContent).toBe("const a = 1")
    expect(screen.getByTestId("mcp-read-path").textContent).toContain("/tmp/a.ts")
    expect(screen.queryByTestId("img")).toBeNull()
  })

  it("returns null without a path so the caller can fall back", () => {
    const { container } = render(<ReadCard part={readPart({ input: {}, output: "x" })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the image instead of the flattened output when the read returned an image block", () => {
    const part = readPart({
      input: { file_path: "/tmp/shot.png" },
      // What `flattenToolResultContent` used to hand the card: a base64 wall.
      output: '/tmp/shot.png (12 bytes){"type":"image","data":"AAAA","mimeType":"image/png"}',
      mcpContent: [
        { type: "text", text: "/tmp/shot.png (12 bytes)" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    })
    render(<ReadCard part={part} />)
    expect(screen.getByTestId("img").getAttribute("src")).toBe("data:image/png;base64,AAAA")
    expect(screen.getByTestId("img").getAttribute("alt")).toBe("/tmp/shot.png")
    // The base64 wall must not also be dumped into a code block.
    expect(screen.queryByTestId("mcp-read-code")).toBeNull()
  })

  it("renders an image carried in the Anthropic source shape", () => {
    const part = readPart({
      input: { path: "/tmp/shot.jpg" },
      output: "",
      mcpContent: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
      ],
    })
    render(<ReadCard part={part} />)
    expect(screen.getByTestId("img").getAttribute("src")).toBe("data:image/jpeg;base64,BBBB")
  })

  it("renders every image block when the read returned more than one", () => {
    const part = readPart({
      input: { file_path: "/tmp/pages.pdf" },
      output: "",
      mcpContent: [
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "image", data: "BBBB", mimeType: "image/png" },
      ],
    })
    render(<ReadCard part={part} />)
    expect(screen.getAllByTestId("img")).toHaveLength(2)
  })

  it("keeps the code block when mcpContent carries no image (e.g. an embedded resource)", () => {
    const part = readPart({
      output: "const a = 1",
      mcpContent: [{ type: "resource", resource: { uri: "file:///a.ts", text: "const a = 1" } }],
    })
    render(<ReadCard part={part} />)
    expect(screen.getByTestId("mcp-read-code")).toBeInTheDocument()
    expect(screen.queryByTestId("img")).toBeNull()
  })

  it("shows the offset/limit window in the path line", () => {
    render(
      <ReadCard
        part={readPart({ input: { file_path: "/tmp/a.ts", offset: 10, limit: 5 }, output: "x" })}
      />
    )
    const line = screen.getByTestId("mcp-read-path").textContent ?? ""
    expect(line).toContain("offset 10")
    expect(line).toContain("limit 5")
  })

  it("joins a lines[] payload back into the code block", () => {
    render(<ReadCard part={readPart({ output: JSON.stringify({ lines: ["a", "b"] }) })} />)
    expect(screen.getByTestId("code").textContent).toBe("a\nb")
  })

  it("renders the path alone when the tool has produced no output yet", () => {
    render(
      <ReadCard
        part={
          {
            type: "tool-Read",
            toolCallId: "c1",
            state: "input-available",
            input: { file_path: "/tmp/a.ts" },
          } as unknown as ToolUIPart
        }
      />
    )
    expect(screen.getByTestId("mcp-read-path").textContent).toContain("/tmp/a.ts")
    expect(screen.queryByTestId("mcp-read-code")).toBeNull()
  })

  it("returns null when the part carries no input at all", () => {
    const { container } = render(
      <ReadCard
        part={
          {
            type: "tool-Read",
            toolCallId: "c1",
            state: "output-available",
          } as unknown as ToolUIPart
        }
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
