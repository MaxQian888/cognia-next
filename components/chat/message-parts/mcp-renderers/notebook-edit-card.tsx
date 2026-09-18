"use client"

import { useMemo } from "react"
import type { ToolUIPart } from "ai"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { PreviewClampNote, useClampedRows } from "./common"
import { basenameOf } from "@/lib/files/file-type-icon"
import { WorkbenchFileLink } from "./workbench-file-link"

interface NotebookEditInput {
  notebook_path?: string
  cell_id?: string
  new_source?: string
  cell_type?: string
  edit_mode?: string
}

/**
 * Body content for the Claude built-in `NotebookEdit` tool: the target
 * notebook, the edit mode / cell type / cell id, and the new cell source as a
 * highlighted code block (python or markdown by cell type). Rendered bare —
 * the surrounding row owns the card chrome now. Returns `null` (→ generic
 * ToolBody) without a notebook path.
 */
export function NotebookEditCard({ part, sessionId }: { part: ToolUIPart; sessionId?: string }) {
  const input = (part.input ?? {}) as NotebookEditInput
  // A large cell source clamps to the same preview budget as the other
  // file-tool bodies; Show-all reveals it inside CodeBlock's own line cap.
  const sourceLines = useMemo(
    () => (typeof input.new_source === "string" ? input.new_source.split("\n") : []),
    [input.new_source]
  )
  const clamp = useClampedRows(sourceLines)
  const previewSource = clamp.hidden > 0 ? clamp.visible.join("\n") : input.new_source
  if (!input.notebook_path) return null

  const lang = input.cell_type === "markdown" ? "markdown" : "python"

  return (
    <div className="min-w-0" data-testid="mcp-notebookedit-card">
      {input.new_source ? (
        <div data-testid="mcp-notebookedit-source">
          <CodeBlock
            code={previewSource ?? ""}
            language={lang}
            filename={basenameOf(input.notebook_path)}
            headerTitle={
              <WorkbenchFileLink
                sessionId={sessionId}
                path={input.notebook_path}
                data-testid="mcp-notebookedit-path-link"
              >
                {basenameOf(input.notebook_path)}
              </WorkbenchFileLink>
            }
            showLineNumbers
            compact
          />
          {clamp.hidden > 0 && (
            <PreviewClampNote
              shown={clamp.shown}
              total={clamp.total}
              onExpand={clamp.reveal}
              testId="mcp-notebookedit-clamped"
            />
          )}
        </div>
      ) : (
        // No source to host the link in — the path row is the whole payload.
        <p className="font-mono text-[11px] text-foreground" data-testid="mcp-notebookedit-path">
          <WorkbenchFileLink
            sessionId={sessionId}
            path={input.notebook_path}
            data-testid="mcp-notebookedit-path-link"
          />
        </p>
      )}
    </div>
  )
}
