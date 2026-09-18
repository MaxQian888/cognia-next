"use client"

// Body content for the core `write` tool (and SDK `Write`): target path +
// a syntax-highlighted preview of the content being written, plus the
// workbench review affordance. Rendered bare — the surrounding row owns the
// card chrome now.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import type { ToolUIPart } from "ai"
import { languageFromPath, PreviewClampNote, useClampedRows } from "./common"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { basenameOf } from "@/lib/files/file-type-icon"
import { WorkbenchReviewButton } from "./workbench-review-button"
import { WorkbenchFileLink } from "./workbench-file-link"

const PREVIEW_CHAR_CAP = 4_000

interface WriteInput {
  file_path?: string
  path?: string
  content?: string
}

export function WriteCard({ part, sessionId }: { part: ToolUIPart; sessionId?: string }) {
  const t = useTranslations("chat.mcp.write")
  const input = (part.input ?? {}) as WriteInput
  const path = input.file_path ?? input.path
  const content = typeof input.content === "string" ? input.content : ""
  // Slicing the preview and counting lines both scan the full file content;
  // recompute only when the written content changes, not on every render.
  // Two budgets: TOOL_PREVIEW_MAX_LINES keeps the row expansion readable, and
  // PREVIEW_CHAR_CAP catches minified payloads whose few lines are enormous.
  // Show-all bypasses both — CodeBlock's own line cap bounds the extreme case.
  const lines = useMemo(() => content.split("\n"), [content])
  const clamp = useClampedRows(lines)
  const lineCount = lines.length
  const { preview, clipped, shownLines } = useMemo(() => {
    const base = clamp.hidden > 0 ? clamp.visible.join("\n") : content
    const charClipped = !clamp.revealed && base.length > PREVIEW_CHAR_CAP
    const p = charClipped ? base.slice(0, PREVIEW_CHAR_CAP) : base
    return {
      preview: p,
      clipped: clamp.hidden > 0 || charClipped,
      shownLines: p === "" ? 0 : p.split("\n").length,
    }
  }, [content, clamp.hidden, clamp.revealed, clamp.visible])
  if (!path || typeof input.content !== "string") return null

  // The row above states path + line count; the block's header carries the
  // file identity (basename link), and review/clamp chrome sits underneath.
  return (
    <div className="min-w-0" data-testid="mcp-write-card">
      <div data-testid="mcp-write-code">
        <CodeBlock
          code={preview}
          language={languageFromPath(path)}
          filename={basenameOf(path)}
          headerTitle={
            <span data-testid="mcp-write-path">
              <WorkbenchFileLink sessionId={sessionId} path={path}>
                {basenameOf(path)}
              </WorkbenchFileLink>
            </span>
          }
          showLineNumbers
          compact
        />
        <div className="flex items-center justify-between gap-2">
          {clipped ? (
            <PreviewClampNote
              // The note is unit-agnostic — report whichever budget bound
              // the preview (lines normally, characters for minified input).
              shown={clamp.hidden > 0 ? shownLines : preview.length}
              total={clamp.hidden > 0 ? lineCount : content.length}
              onExpand={clamp.reveal}
              hint={t("truncated")}
              testId="mcp-write-clamped"
            />
          ) : (
            <span />
          )}
          <WorkbenchReviewButton sessionId={sessionId} absolutePath={path} />
        </div>
      </div>
    </div>
  )
}
