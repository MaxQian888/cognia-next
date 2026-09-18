"use client"

// Body content for the core `edit` and `multi_edit` tools (and SDK
// `Edit`/`MultiEdit` payloads, which share the same input shape). Shows the
// target path and a before/after diff per edit. Rendered bare — the
// surrounding row owns the card chrome now.

import { useMemo } from "react"
import type { ToolUIPart } from "ai"
import { PreviewClampNote, TOOL_PREVIEW_MAX_EDITS, useClampedRows } from "./common"
import { DiffPreview } from "./diff-preview"

interface EditEntry {
  old_string?: string
  new_string?: string
  replace_all?: boolean
}

interface EditInput extends EditEntry {
  file_path?: string
  path?: string
  edits?: EditEntry[]
}

export function EditCard({ part }: { part: ToolUIPart; sessionId?: string }) {
  const input = (part.input ?? {}) as EditInput
  const path = input.file_path ?? input.path

  const resultText = typeof part.output === "string" ? part.output : undefined
  // Only the first line is shown — slice at the first newline instead of
  // splitting the whole (potentially large) string. Keep the original
  // truthiness guard on `resultText` so the rendered DOM is identical.
  const resultFirstLine = useMemo(() => {
    if (resultText === undefined) return undefined
    const nl = resultText.indexOf("\n")
    return nl === -1 ? resultText : resultText.slice(0, nl)
  }, [resultText])

  const edits: EditEntry[] = useMemo(() => {
    const inp = (part.input ?? {}) as EditInput
    return Array.isArray(inp.edits) ? inp.edits : typeof inp.old_string === "string" ? [inp] : []
  }, [part.input])
  // A multi_edit payload with many edits mounts one DiffPreview each; clamp
  // the list so a mass-refactor call doesn't flood the row with diff blocks.
  const clamp = useClampedRows(edits, TOOL_PREVIEW_MAX_EDITS)

  if (!path) return null
  if (edits.length === 0) return null

  return (
    <div className="min-w-0" data-testid="mcp-edit-card">
      {/* The row above already owns the file's identity (path + review/open
          affordances) — the body carries only the diffs and the result note. */}
      <div className="min-w-0 flex-1 space-y-2">
        {clamp.visible.map((e, i) => (
          <DiffPreview key={i} oldText={e.old_string ?? ""} newText={e.new_string ?? ""} />
        ))}
        {clamp.hidden > 0 && (
          <PreviewClampNote
            shown={clamp.shown}
            total={clamp.total}
            onExpand={clamp.reveal}
            testId="mcp-edit-clamped"
          />
        )}
        {resultText && (
          <p className="text-[11px] text-muted-foreground" data-testid="mcp-edit-result">
            {resultFirstLine}
          </p>
        )}
      </div>
    </div>
  )
}
