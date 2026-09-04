"use client"

import { NotebookPenIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { McpCardShell } from "./common"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { WorkbenchFileLink } from "./workbench-file-link"

interface NotebookEditInput {
  notebook_path?: string
  cell_id?: string
  new_source?: string
  cell_type?: string
  edit_mode?: string
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/**
 * Renderer for the Claude built-in `NotebookEdit` tool: the target notebook, the
 * edit mode / cell type / cell id, and the new cell source as a highlighted
 * code block (python or markdown by cell type). Technical params are shown raw,
 * matching ReadCard. Returns `null` (→ generic ToolBody) without a notebook path.
 */
export function NotebookEditCard({ part, sessionId }: { part: ToolUIPart; sessionId?: string }) {
  const input = (part.input ?? {}) as NotebookEditInput
  if (!input.notebook_path) return null

  const lang = input.cell_type === "markdown" ? "markdown" : "python"
  const meta = [input.edit_mode, input.cell_type, input.cell_id && `cell ${input.cell_id}`]
    .filter(Boolean)
    .join(" · ")

  return (
    <McpCardShell
      title={/* i18n-exempt: the tool's own name, identical in every locale */ "NotebookEdit"}
      badge={basename(input.notebook_path)}
      testId="mcp-notebookedit-card"
    >
      <div className="flex items-start gap-2">
        <NotebookPenIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] text-foreground" data-testid="mcp-notebookedit-path">
            <WorkbenchFileLink
              sessionId={sessionId}
              path={input.notebook_path}
              data-testid="mcp-notebookedit-path-link"
            />
          </p>
          {meta && <p className="text-[11px] text-muted-foreground">{meta}</p>}
          {input.new_source && (
            <div className="mt-1" data-testid="mcp-notebookedit-source">
              <CodeBlock code={input.new_source} language={lang} showLineNumbers />
            </div>
          )}
        </div>
      </div>
    </McpCardShell>
  )
}
