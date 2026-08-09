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

  it("recognises Claude built-ins", () => {
    expect(isStructuredMcpToolPart(part("tool-Read"))).toBe(true)
    expect(isStructuredMcpToolPart(part("tool-Glob"))).toBe(true)
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

  it("recognises the sidecar coreFiles suite — bare and namespaced", () => {
    for (const name of ["read", "glob", "grep", "ls", "edit", "multi_edit", "write"]) {
      expect(isStructuredMcpToolPart(part(`tool-${name}`))).toBe(true)
      expect(isStructuredMcpToolPart(part(`tool-mcp__cognia-tools__${name}`))).toBe(true)
    }
  })

  it("recognises the native Anthropic PascalCase LS tool", () => {
    expect(isStructuredMcpToolPart(part("tool-LS"))).toBe(true)
  })

  it("recognises the workflow proposal plugin tools — bare and plugin-namespaced", () => {
    for (const name of ["wf_propose_batch", "wf_apply_template"]) {
      expect(isStructuredMcpToolPart(part(`tool-${name}`))).toBe(true)
      expect(isStructuredMcpToolPart(part(`tool-mcp__cognia-plugin-tools__${name}`))).toBe(true)
    }
  })

  it("normalizeToolName strips only the cognia-tools prefix", () => {
    expect(normalizeToolName("mcp__cognia-tools__grep")).toBe("grep")
    expect(normalizeToolName("grep")).toBe("grep")
    expect(normalizeToolName("mcp__other-server__grep")).toBe("mcp__other-server__grep")
  })
})

describe("MCPToolCard — coreFiles routing", () => {
  it("routes the namespaced core read to the ReadCard", () => {
    render(
      <MCPToolCard
        part={part("tool-mcp__cognia-tools__read", "     1\tconsole.log(1)", {
          file_path: "a.ts",
        })}
      />
    )
    expect(screen.getByTestId("mcp-read-path")).toHaveTextContent("a.ts")
  })

  it("routes core edit to the EditCard diff view", () => {
    render(
      <MCPToolCard
        part={part("tool-edit", "Edited a.ts: 1 replacement.", {
          file_path: "a.ts",
          old_string: "x = 1",
          new_string: "x = 2",
        })}
      />
    )
    expect(screen.getByTestId("mcp-edit-card")).toBeInTheDocument()
    expect(screen.getByTestId("diff-preview")).toBeInTheDocument()
  })

  it("routes core ls to the LsCard", () => {
    render(<MCPToolCard part={part("tool-ls", "D:/proj\nsrc/\nfile.ts", { path: "." })} />)
    expect(screen.getAllByTestId("mcp-ls-entry")).toHaveLength(2)
  })

  it("routes the native Anthropic LS to the same LsCard", () => {
    render(<MCPToolCard part={part("tool-LS", "D:/proj\nsrc/\nfile.ts", { path: "." })} />)
    expect(screen.getAllByTestId("mcp-ls-entry")).toHaveLength(2)
  })

  it("routes core write to the WriteCard", () => {
    render(
      <MCPToolCard part={part("tool-write", "Created a.ts", { file_path: "a.ts", content: "x" })} />
    )
    expect(screen.getByTestId("mcp-write-card")).toBeInTheDocument()
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
    // `write` has a dedicated card that renders off the string output; if a
    // result ever carries real blocks, the blocks win — a card must never
    // silently drop an image/resource because it only knows about `output`.
    const p = {
      ...part("tool-write", "wrote a.ts", { file_path: "a.ts", content: "x" }),
      mcpContent: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    } as unknown as ToolUIPart
    render(<MCPToolCard part={p} />)
    expect(screen.getByTestId("mcp-content-blocks")).toBeInTheDocument()
    expect(screen.queryByTestId("mcp-write-card")).toBeNull()
  })

  it("lets the Read card keep structured content because it renders the blocks itself", () => {
    const p = {
      ...part("tool-Read", "/tmp/a.png (12 bytes)", { file_path: "/tmp/a.png" }),
      mcpContent: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    } as unknown as ToolUIPart
    render(<MCPToolCard part={p} />)
    expect(screen.getByTestId("mcp-read-image")).toBeInTheDocument()
    expect(screen.queryByTestId("mcp-content-blocks")).toBeNull()
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
    render(<MCPToolCard part={dynamicPart("Read", "const a = 1", { file_path: "a.ts" })} />)
    expect(screen.getByTestId("mcp-read-path")).toHaveTextContent("a.ts")
  })

  it("falls back to ToolBody for an unregistered dynamic tool", () => {
    render(<MCPToolCard part={dynamicPart("MysteryTool", "raw")} />)
    expect(screen.getByTestId("generic-tool-body")).toBeInTheDocument()
  })

  it("isStructuredMcpToolPart recognises a dynamic-tool by its toolName", () => {
    expect(isStructuredMcpToolPart(dynamicPart("Read"))).toBe(true)
    expect(isStructuredMcpToolPart(dynamicPart("MysteryTool"))).toBe(false)
    expect(isStructuredMcpToolPart(part("tool-Read"))).toBe(true)
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
    expect(screen.getByTestId("mcp-wiki-search-card-badge")).toHaveTextContent("2 hits")
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
    expect(screen.getByTestId("mcp-wiki-read-title")).toHaveTextContent("Introduction")
    expect(screen.getAllByTestId("mcp-wiki-read-section")).toHaveLength(2)
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

describe("MCPToolCard — Read", () => {
  it("renders a CodeBlock with language derived from extension", () => {
    render(
      <MCPToolCard part={part("tool-Read", { content: "console.log(1)" }, { path: "a.ts" })} />
    )
    expect(screen.getByTestId("mcp-read-path")).toHaveTextContent("a.ts")
    expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "typescript")
  })
})

describe("MCPToolCard — Glob", () => {
  it("renders match rows from a JSON array output", () => {
    render(
      <MCPToolCard
        part={part("tool-Glob", JSON.stringify({ matches: ["src/a.ts", "src/b.ts"] }), {
          pattern: "src/*.ts",
        })}
      />
    )
    expect(screen.getByTestId("mcp-glob-pattern")).toHaveTextContent("src/*.ts")
    expect(screen.getAllByTestId("mcp-glob-match")).toHaveLength(2)
  })

  it("splits a plain-string output into one match per line", () => {
    render(
      <MCPToolCard part={part("tool-Glob", "src/a.ts\nsrc/b.ts\n", { pattern: "src/*.ts" })} />
    )
    expect(screen.getAllByTestId("mcp-glob-match")).toHaveLength(2)
  })
})

describe("MCPToolCard — Grep", () => {
  it("is recognised as a structured tool", () => {
    expect(isStructuredMcpToolPart(part("tool-Grep"))).toBe(true)
  })

  it("renders matched content lines from a plain-string output", () => {
    render(
      <MCPToolCard
        part={part("tool-Grep", "a.ts:1:const x = 1\nb.ts:2:const y = 2\n", {
          pattern: "const",
          glob: "*.ts",
          output_mode: "content",
        })}
      />
    )
    expect(screen.getByTestId("mcp-grep-pattern")).toHaveTextContent("const")
    expect(screen.getByTestId("mcp-grep-pattern")).toHaveTextContent("*.ts")
    expect(screen.getAllByTestId("mcp-grep-match")).toHaveLength(2)
  })

  it("renders files from a JSON { files: [...] } output", () => {
    render(
      <MCPToolCard
        part={part("tool-Grep", JSON.stringify({ files: ["a.ts", "b.ts", "c.ts"] }), {
          pattern: "TODO",
        })}
      />
    )
    expect(screen.getAllByTestId("mcp-grep-match")).toHaveLength(3)
  })

  it("shows the empty state when there are no matches", () => {
    render(
      <MCPToolCard part={part("tool-Grep", JSON.stringify({ matches: [] }), { pattern: "zzz" })} />
    )
    expect(screen.getByTestId("mcp-grep-card")).toHaveTextContent("No matches")
  })

  it("falls back to ToolBody when there is neither a pattern nor matches", () => {
    render(<MCPToolCard part={part("tool-Grep", "")} />)
    expect(screen.getByTestId("generic-tool-body")).toBeInTheDocument()
  })
})

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
    expect(screen.getByTestId("mcp-webfetch-url")).toHaveTextContent("https://example.com/docs")
    expect(screen.getByTestId("mcp-webfetch-card")).toHaveTextContent("example.com")
    expect(screen.getByTestId("mcp-webfetch-content")).toHaveTextContent("Fetched page body text")
  })

  it("falls back to ToolBody without a URL", () => {
    render(<MCPToolCard part={part("tool-WebFetch", "x")} />)
    expect(screen.getByTestId("generic-tool-body")).toBeInTheDocument()
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
    expect(screen.getByTestId("mcp-websearch-query")).toHaveTextContent("test query")
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
})

describe("MCPToolCard — NotebookEdit", () => {
  it("renders the notebook path, meta and the cell source", () => {
    render(
      <MCPToolCard
        part={part("tool-NotebookEdit", "ok", {
          notebook_path: "/work/analysis.ipynb",
          cell_type: "python",
          edit_mode: "replace",
          new_source: "print(1)",
        })}
      />
    )
    expect(screen.getByTestId("mcp-notebookedit-path")).toHaveTextContent("/work/analysis.ipynb")
    expect(screen.getByTestId("mcp-notebookedit-card")).toHaveTextContent("analysis.ipynb")
    expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "python")
  })

  it("falls back to ToolBody without a notebook path", () => {
    render(<MCPToolCard part={part("tool-NotebookEdit", "ok", { new_source: "x" })} />)
    expect(screen.getByTestId("generic-tool-body")).toBeInTheDocument()
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
