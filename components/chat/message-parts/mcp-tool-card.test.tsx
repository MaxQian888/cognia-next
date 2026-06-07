/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import { MCPToolCard, isStructuredMcpToolType, normalizeToolName } from "./mcp-tool-card"

jest.mock("@/components/ai-elements/tool", () => ({
  ToolBody: () => <div data-testid="generic-tool-body" />,
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

const part = (type: string, output?: unknown, input?: unknown): ToolUIPart =>
  ({
    type,
    toolCallId: "call",
    state: "output-available",
    input,
    output,
  }) as unknown as ToolUIPart

describe("isStructuredMcpToolType", () => {
  it("recognises cognia tools", () => {
    expect(isStructuredMcpToolType("tool-wiki_search")).toBe(true)
    expect(isStructuredMcpToolType("tool-wiki_read")).toBe(true)
    expect(isStructuredMcpToolType("tool-rag_search")).toBe(true)
    expect(isStructuredMcpToolType("tool-runtime_query")).toBe(true)
  })

  it("recognises Claude built-ins", () => {
    expect(isStructuredMcpToolType("tool-Plan")).toBe(true)
    expect(isStructuredMcpToolType("tool-Read")).toBe(true)
    expect(isStructuredMcpToolType("tool-Glob")).toBe(true)
  })

  it("rejects unknown tools and non-tool types", () => {
    expect(isStructuredMcpToolType("tool-MysteryTool")).toBe(false)
    expect(isStructuredMcpToolType("text")).toBe(false)
    expect(isStructuredMcpToolType("Glob")).toBe(false)
  })

  it("recognises the sidecar coreFiles suite — bare and namespaced", () => {
    for (const name of ["read", "glob", "grep", "ls", "edit", "multi_edit", "write"]) {
      expect(isStructuredMcpToolType(`tool-${name}`)).toBe(true)
      expect(isStructuredMcpToolType(`tool-mcp__cognia-tools__${name}`)).toBe(true)
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

  it("falls back to ToolBody when the type isn't a tool", () => {
    render(<MCPToolCard part={part("text", "raw")} />)
    expect(screen.getByTestId("generic-tool-body")).toBeInTheDocument()
  })

  it("falls back to ToolBody when the structured payload is unparseable", () => {
    render(<MCPToolCard part={part("tool-wiki_search", "not json")} />)
    expect(screen.getByTestId("generic-tool-body")).toBeInTheDocument()
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

describe("MCPToolCard — Plan", () => {
  it("renders one row per plan step with status data", () => {
    const input = {
      steps: [
        { content: "Step 1", status: "completed" },
        { content: "Step 2", status: "in_progress" },
        { content: "Step 3" },
      ],
    }
    render(<MCPToolCard part={part("tool-Plan", undefined, input)} />)
    const steps = screen.getAllByTestId("mcp-plan-step")
    expect(steps).toHaveLength(3)
    expect(steps[0]).toHaveAttribute("data-status", "completed")
    expect(steps[1]).toHaveAttribute("data-status", "in_progress")
    expect(steps[2]).toHaveAttribute("data-status", "pending")
  })

  it("falls back to ToolBody when there are no steps", () => {
    render(<MCPToolCard part={part("tool-Plan", undefined, { steps: [] })} />)
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
    expect(isStructuredMcpToolType("tool-Grep")).toBe(true)
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
