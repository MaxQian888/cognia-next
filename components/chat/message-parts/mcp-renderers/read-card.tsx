"use client"

import { FileIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { McpCardShell, useParsedOutput } from "./common"
import { CodeBlock } from "@/components/chat/renderers/code-block"

interface ReadInput {
  path?: string
  file_path?: string
  offset?: number
  limit?: number
}

interface ReadOutput {
  content?: string
  lines?: string[]
  startLine?: number
}

function languageFromPath(path: string | undefined): string {
  if (!path) return "text"
  const ext = path.toLowerCase().split(".").pop() ?? ""
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    rb: "ruby",
    cs: "csharp",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    md: "markdown",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    css: "css",
    html: "html",
    sh: "bash",
    sql: "sql",
  }
  return map[ext] ?? "text"
}

export function ReadCard({ part }: { part: ToolUIPart }) {
  const input = (part.input ?? {}) as ReadInput
  const path = input.path ?? input.file_path
  const parsed = useParsedOutput<ReadOutput>(part.output)
  if (!path) return null

  const code =
    parsed?.content ??
    (Array.isArray(parsed?.lines) ? parsed!.lines.join("\n") : undefined) ??
    (typeof part.output === "string" ? part.output : "")

  return (
    <McpCardShell title="Read" badge={path} testId="mcp-read-card">
      <div className="flex items-start gap-2">
        <FileIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] text-muted-foreground" data-testid="mcp-read-path">
            {path}
            {input.offset !== undefined && ` · offset ${input.offset}`}
            {input.limit !== undefined && ` · limit ${input.limit}`}
          </p>
          {code && (
            <div className="mt-1" data-testid="mcp-read-code">
              <CodeBlock code={code} language={languageFromPath(path)} showLineNumbers />
            </div>
          )}
        </div>
      </div>
    </McpCardShell>
  )
}
