"use client"

import { useMemo } from "react"
import { FileIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { McpCardShell, languageFromPath, useParsedOutput } from "./common"
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

export function ReadCard({ part }: { part: ToolUIPart }) {
  const input = (part.input ?? {}) as ReadInput
  const path = input.path ?? input.file_path
  const parsed = useParsedOutput<ReadOutput>(part.output)
  // Joining a multi-line `lines[]` payload back into a single string can be
  // expensive for large files; recompute only when the parsed/raw output moves.
  const code = useMemo(
    () =>
      parsed?.content ??
      (Array.isArray(parsed?.lines) ? parsed!.lines.join("\n") : undefined) ??
      (typeof part.output === "string" ? part.output : ""),
    [parsed, part.output]
  )
  if (!path) return null

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
