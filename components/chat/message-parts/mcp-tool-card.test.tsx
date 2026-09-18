/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import { MCPToolCard, isStructuredMcpToolPart, normalizeToolName } from "./mcp-tool-card"
import {
  clearAllToolResultRenderers,
  registerToolResultRenderer,
} from "@/lib/plugin/api/tool-result-renderers"

jest.mock("@/components/ai-elements/tool", () => ({
  ToolBody: () => <div data-testid="generic-tool-body" />,
  ToolInput: ({ input }: { input: unknown }) => (
    <div data-testid="tool-input">{JSON.stringify(input)}</div>
  ),
}))

jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}))

jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string }) => (
    <pre data-testid="code-block" data-language={language}>
      {code}
    </pre>
  ),
}))

// ImageBlock pulls in the lightbox + Radix tooltips; the routing assertions
// only care that an image landed, not how it renders.
jest.mock("@/components/chat/renderers/image-block", () => ({
  ImageBlock: ({ src }: { src: string }) => <img data-testid="image-block" src={src} alt="" />,
}))

const part = (type: string, output?: unknown, input?: unknown): ToolUIPart =>
  ({
    type,
    toolCallId: "call",
    state: "output-available",
    input,
    output,
  }) as unknown as ToolUIPart

describe("isStructuredMcpToolPart", () => {
  it("recognises cognia tools", () => {
    expect(isStructuredMcpToolPart(part("tool-wiki_search"))).toBe(true)
    expect(isStructuredMcpToolPart(part("tool-wiki_read"))).toBe(true)
    expect(isStructuredMcpToolPart(part("tool-rag_search"))).toBe(true)
    expect(isStructuredMcpToolPart(part("tool-runtime_query"))).toBe(true)
    expect(isStructuredMcpToolPart(part("tool-spawn_task"))).toBe(true)
    expect(isStructuredMcpToolPart(part("tool-mcp__cognia-tools__spawn_task"))).toBe(true)
    expect(isStructuredMcpToolPart(part("tool-mcp__cognia-plugin-tools__spawn_task"))).toBe(true)
  })

  it("recognises the Claude built-ins that still own cards here", () => {
    expect(isStructuredMcpToolPart(part("tool-WebFetch"))).toBe(true)
    expect(isStructuredMcpToolPart(part("tool-WebSearch"))).toBe(true)
    expect(isStructuredMcpToolPart(part("tool-web_fetch"))).toBe(true)
    expect(isStructuredMcpToolPart(part("tool-web_search"))).toBe(true)
  })

  // The file tools moved out of this registry: `FileToolPart` owns them
  // upstream. A structured-card claim here would only fire when the row
  // routing was bypassed — it must stay false.
  it("does not claim the file tools — bare, PascalCase or namespaced", () => {
    for (const name of [
      "read",
      "write",
      "edit",
      "multi_edit",
      "grep",
      "glob",
      "ls",
      "notebookedit",
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Grep",
      "Glob",
      "LS",
      "NotebookEdit",
    ]) {
      expect(isStructuredMcpToolPart(part(`tool-${name}`))).toBe(false)
      expect(isStructuredMcpToolPart(part(`tool-mcp__cognia-tools__${name}`))).toBe(false)
    }
  })

  it("recognises the plan-mode signal tools — native, bare and cognia-namespaced", () => {
    expect(isStructuredMcpToolPart(part("tool-ExitPlanMode"))).toBe(true)
    expect(isStructuredMcpToolPart(part("tool-exit_plan_mode"))).toBe(true)
    expect(isStructuredMcpToolPart(part("tool-mcp__cognia-tools__exit_plan_mode"))).toBe(true)
    // The dead `Plan` tool name no longer routes anywhere.
    expect(isStructuredMcpToolPart(part("tool-Plan"))).toBe(false)
  })

  it("rejects unknown tools and non-tool types", () => {
    expect(isStructuredMcpToolPart(part("tool-MysteryTool"))).toBe(false)
    expect(isStructuredMcpToolPart(part("text"))).toBe(false)
    expect(isStructuredMcpToolPart(part("Glob"))).toBe(false)
  })

  it("recognises the workflow proposal plugin tools — bare and plugin-namespaced", () => {
    for (const name of ["wf_propose_batch", "wf_apply_template"]) {
      expect(isStructuredMcpToolPart(part(`tool-${name}`))).toBe(true)
      expect(isStructuredMcpToolPart(part(`tool-mcp__cognia-plugin-tools__${name}`))).toBe(true)
    }
  })

  it("normalizes both promoted Cognia MCP namespaces", () => {
    expect(normalizeToolName("mcp__cognia-tools__grep")).toBe("grep")
    expect(normalizeToolName("mcp__cognia-plugin-tools__web_search")).toBe("web_search")
    expect(normalizeToolName("mcp__cognia-plugin-tools__web_fetch")).toBe("web_fetch")
    expect(normalizeToolName("grep")).toBe("grep")
    expect(normalizeToolName("mcp__other-server__grep")).toBe("mcp__other-server__grep")
  })
})

// File tools are owned by `FileToolPart` upstream — nothing in the app routes
// them here. When one does land (a caller that skipped the body router), the
// contract is the generic body, never the retired card path.
describe("MCPToolCard — file tools degrade to the generic body", () => {
  it.each([
    ["tool-mcp__cognia-tools__read", { file_path: "a.ts" }],
    ["tool-Read", { file_path: "a.ts" }],
    ["tool-edit", { file_path: "a.ts", old_string: "x", new_string: "y" }],
    ["tool-ls", { path: "." }],
    ["tool-LS", { path: "." }],
    ["tool-write", { file_path: "a.ts", content: "x" }],
    ["tool-NotebookEdit", { notebook_path: "a.ipynb", new_source: "x" }],
  ])("%s renders the generic body", (type, input) => {
    render(<MCPToolCard part={part(type, "out", input)} />)
    expect(screen.getByTestId("generic-tool-body")).toBeInTheDocument()
  })
})

describe("MCPToolCard — fallback semantics", () => {
  it("falls back to ToolBody when the tool name isn't recognised", () => {
    render(<MCPToolCard part={part("tool-MysteryTool", "raw")} />)
    expect(screen.getByTestId("generic-tool-body")).toBeInTheDocument()
  })

  it("renders structured MCP content blocks (gap3) instead of ToolBody when present", () => {
    const p = {
      ...part("tool-mcp__some-server__capture", "stringified output"),
      mcpContent: [{ type: "text", text: "rich body" }],
    } as unknown as ToolUIPart
    render(<MCPToolCard part={p} />)
    expect(screen.getByTestId("mcp-content-blocks")).toBeInTheDocument()
    expect(screen.getByTestId("md").textContent).toBe("rich body")
    expect(screen.queryByTestId("generic-tool-body")).toBeNull()
  })

  it("falls back to ToolBody when the type isn't a tool", () => {
    render(<MCPToolCard part={part("text", "raw")} />)
    expect(screen.getByTestId("generic-tool-body")).toBeInTheDocument()
  })

  it("falls back to ToolBody when the structured payload is unparseable", () => {
    render(<MCPToolCard part={part("tool-wiki_search", "not json")} />)
    expect(screen.getByTestId("generic-tool-body")).toBeInTheDocument()
  })

  it("bypasses a dedicated card that would swallow structured content blocks", () => {
    // `web_fetch` has a dedicated card that renders off the string output; if a
    // result ever carries real blocks, the blocks win — a card must never
    // silently drop an image/resource because it only knows about `output`.
    const p = {
      ...part("tool-web_fetch", "fetched", { url: "https://example.com" }),
      mcpContent: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    } as unknown as ToolUIPart
    render(<MCPToolCard part={p} />)
    expect(screen.getByTestId("mcp-content-blocks")).toBeInTheDocument()
    expect(screen.queryByTestId("mcp-webfetch-card")).toBeNull()
  })

  it("surfaces structured content blocks even for a file tool that lands here", () => {
    // FileToolPart owns Read upstream; if one arrives anyway the blocks must
    // still render rather than disappearing with the retired card path.
    const p = {
      ...part("tool-Read", "/tmp/a.png (12 bytes)", { file_path: "/tmp/a.png" }),
      mcpContent: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    } as unknown as ToolUIPart
    render(<MCPToolCard part={p} />)
    expect(screen.getByTestId("mcp-content-blocks")).toBeInTheDocument()
  })
})

describe("MCPToolCard — dynamic-tool parts", () => {
  const dynamicPart = (toolName: string, output?: unknown, input?: unknown): ToolUIPart =>
    ({
      type: "dynamic-tool",
      toolName,
      toolCallId: "call",
      state: "output-available",
      input,
      output,
    }) as unknown as ToolUIPart

  it("routes a dynamic-tool part to the card registered for its toolName", () => {
    render(
      <MCPToolCard
        part={dynamicPart("web_fetch", "fetched body", { url: "https://example.com" })}
      />
    )
    expect(screen.getByTestId("mcp-webfetch-card")).toBeInTheDocument()
  })

  it("falls back to ToolBody for an unregistered dynamic tool", () => {
    render(<MCPToolCard part={dynamicPart("MysteryTool", "raw")} />)
    expect(screen.getByTestId("generic-tool-body")).toBeInTheDocument()
  })

  it("isStructuredMcpToolPart recognises a dynamic-tool by its toolName", () => {
    expect(isStructuredMcpToolPart(dynamicPart("WebFetch"))).toBe(true)
    expect(isStructuredMcpToolPart(dynamicPart("MysteryTool"))).toBe(false)
    // A dynamic `Read` still names a file tool — FileToolPart's claim, not
    // this registry's.
    expect(isStructuredMcpToolPart(dynamicPart("Read"))).toBe(false)
    expect(isStructuredMcpToolPart(part("tool-WebFetch"))).toBe(true)
    expect(isStructuredMcpToolPart(part("text"))).toBe(false)
  })
})

describe("MCPToolCard — wiki_search", () => {
  it("renders a row per hit with slug + score", () => {
    const output = JSON.stringify({
      hits: [
        { slug: "intro", title: "Intro", score: 0.91, excerpt: "Welcome" },
        { slug: "deep-dive", title: "Deep Dive", score: 0.72 },
      ],
    })
    render(<MCPToolCard part={part("tool-wiki_search", output)} />)
    const rows = screen.getAllByTestId("mcp-wiki-search-row")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute("data-slug", "intro")
  })

  it("renders an empty message for zero hits", () => {
    render(<MCPToolCard part={part("tool-wiki_search", JSON.stringify({ hits: [] }))} />)
    expect(screen.queryAllByTestId("mcp-wiki-search-row")).toHaveLength(0)
    expect(screen.getByTestId("mcp-wiki-search-card")).toHaveTextContent("No results")
  })
})

describe("MCPToolCard — rag_search", () => {
  it("renders chunk hits with source title + score", () => {
    const output = JSON.stringify({
      hits: [
        { id: "v1", sourceTitle: "doc-a", content: "alpha", score: 0.81, scope: "knowledge" },
        { id: "v2", sourceTitle: "doc-b", content: "beta", score: 0.6 },
      ],
    })
    render(<MCPToolCard part={part("tool-rag_search", output)} />)
    const rows = screen.getAllByTestId("mcp-rag-search-row")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute("data-id", "v1")
  })
})

describe("MCPToolCard — runtime_query", () => {
  it("renders entity rows tagged with kind", () => {
    const output = JSON.stringify({
      kind: "skill",
      entities: [
        { id: "s1", name: "Skill One", description: "First" },
        { id: "s2", name: "Skill Two" },
      ],
    })
    render(<MCPToolCard part={part("tool-runtime_query", output)} />)
    const rows = screen.getAllByTestId("mcp-runtime-query-row")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute("data-kind", "skill")
  })
})

describe("MCPToolCard — wiki_read", () => {
  it("renders the title + sections list", () => {
    const output = JSON.stringify({
      slug: "intro",
      title: "Introduction",
      sections: [
        { heading: "Overview", body: "Welcome." },
        { heading: "Details", body: "Deeper text." },
      ],
    })
    render(<MCPToolCard part={part("tool-wiki_read", output)} />)
    // The article title rides on the row's meta; the body carries sections.
    expect(screen.getAllByTestId("mcp-wiki-read-section")).toHaveLength(2)
    expect(screen.getByText("Deeper text.")).toBeInTheDocument()
  })
})

describe("MCPToolCard — exit_plan_mode", () => {
  it("renders the plan markdown from input.plan", () => {
    render(
      <MCPToolCard
        part={part("tool-ExitPlanMode", undefined, { plan: "## Plan\n\n1. Do the thing" })}
      />
    )
    expect(screen.getByTestId("mcp-plan-card")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-plan-body")).toHaveTextContent("Do the thing")
  })

  it("routes the cognia-namespaced exit_plan_mode to the same card", () => {
    render(
      <MCPToolCard
        part={part("tool-mcp__cognia-tools__exit_plan_mode", undefined, { plan: "do it" })}
      />
    )
    expect(screen.getByTestId("mcp-plan-body")).toHaveTextContent("do it")
  })

  it("falls back to ToolBody when the plan is empty", () => {
    render(<MCPToolCard part={part("tool-exit_plan_mode", undefined, { plan: "   " })} />)
    expect(screen.getByTestId("generic-tool-body")).toBeInTheDocument()
  })
})

// Payload-level assertions for Read/Glob/Grep/LS/Write/Edit/NotebookEdit live
// in the per-card suites under `mcp-renderers/*.test.tsx` — the bodies are the
// same ones `FileToolBody` mounts under the file-tool row.

describe("MCPToolCard — WebFetch", () => {
  it("renders the URL + content preview", () => {
    render(
      <MCPToolCard
        part={part("tool-WebFetch", "Fetched page body text", {
          url: "https://example.com/docs",
          prompt: "summarise",
        })}
      />
    )
    // The URL lives on the StructuredToolPart row — the body shows the
    // extraction prompt and the fetched prose only.
    expect(screen.getByTestId("mcp-webfetch-prompt")).toHaveTextContent("summarise")
    expect(screen.getByTestId("mcp-webfetch-content")).toHaveTextContent("Fetched page body text")
  })

  it("falls back to ToolBody without a URL", () => {
    render(<MCPToolCard part={part("tool-WebFetch", "x")} />)
    expect(screen.getByTestId("generic-tool-body")).toBeInTheDocument()
  })

  it("routes the promoted snake_case tool to the host card", () => {
    render(
      <MCPToolCard
        part={part(
          "tool-web_fetch",
          { ok: true, status: 200, text: "body" },
          {
            url: "https://example.com",
          }
        )}
      />
    )
    expect(screen.getByTestId("mcp-webfetch-card")).toBeInTheDocument()
  })
})

describe("MCPToolCard — WebSearch", () => {
  it("renders result rows from a JSON results array", () => {
    const output = JSON.stringify({
      results: [
        { title: "First", url: "https://a.com/x", snippet: "hello" },
        { title: "Second", url: "https://b.com/y" },
      ],
    })
    render(<MCPToolCard part={part("tool-WebSearch", output, { query: "test query" })} />)
    expect(screen.getAllByTestId("mcp-websearch-result")).toHaveLength(2)
  })

  it("shows the empty state with a query but no results", () => {
    render(
      <MCPToolCard part={part("tool-WebSearch", JSON.stringify({ results: [] }), { query: "q" })} />
    )
    expect(screen.getByTestId("mcp-websearch-card")).toHaveTextContent("No results")
  })

  it("falls back to ToolBody without query or results", () => {
    render(<MCPToolCard part={part("tool-WebSearch", "raw")} />)
    expect(screen.getByTestId("generic-tool-body")).toBeInTheDocument()
  })

  it("routes the promoted snake_case tool to the host card", () => {
    render(
      <MCPToolCard
        part={part(
          "tool-web_search",
          { ok: true, provider: "tavily", results: [] },
          { query: "test" }
        )}
      />
    )
    expect(screen.getByTestId("mcp-websearch-card")).toBeInTheDocument()
  })
})

describe("plugin-contributed tool cards", () => {
  const PluginCard = ({ part: p }: { part: ToolUIPart }) => (
    <div data-testid="plugin-tool-card">{String((p as { output?: unknown }).output)}</div>
  )

  afterEach(() => clearAllToolResultRenderers())

  it("renders a plugin card for a tool the host has no built-in for", () => {
    registerToolResultRenderer("p1", "demo_lookup", PluginCard as never)
    render(<MCPToolCard part={part("tool-demo_lookup", "from the plugin")} />)
    expect(screen.getByTestId("plugin-tool-card")).toHaveTextContent("from the plugin")
    expect(screen.queryByTestId("generic-tool-body")).not.toBeInTheDocument()
  })

  it("resolves the namespaced provider form onto the same plugin card", () => {
    registerToolResultRenderer("p1", "demo_lookup", PluginCard as never)
    render(<MCPToolCard part={part("tool-mcp__cognia-plugin-tools__demo_lookup", "ok")} />)
    expect(screen.getByTestId("plugin-tool-card")).toBeInTheDocument()
  })

  it("lets the host's built-in card win — a plugin cannot shadow Read", () => {
    registerToolResultRenderer("p1", "Read", PluginCard as never)
    render(<MCPToolCard part={part("tool-Read", "contents", { file_path: "/a/b.ts" })} />)
    expect(screen.queryByTestId("plugin-tool-card")).not.toBeInTheDocument()
  })

  it("makes the tool routable — isStructuredMcpToolPart must see the plugin entry", () => {
    // Load-bearing: message-renderer uses this predicate to decide whether the
    // part reaches MCPToolCard at all. False here = registered but unreachable.
    expect(isStructuredMcpToolPart(part("tool-demo_lookup"))).toBe(false)
    registerToolResultRenderer("p1", "demo_lookup", PluginCard as never)
    expect(isStructuredMcpToolPart(part("tool-demo_lookup"))).toBe(true)
  })

  it("contains a crashing plugin card instead of taking down the message", () => {
    const Boom = () => {
      throw new Error("plugin exploded")
    }
    registerToolResultRenderer("p1", "boom_tool", Boom as never)
    const spy = jest.spyOn(console, "error").mockImplementation(() => {})
    render(<MCPToolCard part={part("tool-boom_tool", "x")} />)
    expect(screen.getByRole("alert")).toHaveAttribute("data-plugin-surface-error", "true")
    expect(screen.getByText("p1 could not render")).toBeInTheDocument()
    spy.mockRestore()
  })

  it("still falls back to the generic body when no plugin claims the tool", () => {
    render(<MCPToolCard part={part("tool-unclaimed", "x")} />)
    expect(screen.getByTestId("generic-tool-body")).toBeInTheDocument()
  })
})
