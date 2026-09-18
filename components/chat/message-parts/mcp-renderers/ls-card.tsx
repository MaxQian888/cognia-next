"use client"

// Body content for the core `ls` tool — directory listing, reusing the
// GlobCard list layout. Rendered bare: the surrounding row owns the card
// chrome now.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import type { ToolUIPart } from "ai"
import { PreviewClampNote, TOOL_LIST_MAX_ROWS, useClampedRows } from "./common"
import { FileTypeIcon } from "@/components/shared/file-type-icon"

interface LsInput {
  path?: string
}

export function LsCard({ part }: { part: ToolUIPart }) {
  const t = useTranslations("chat.mcp.ls")
  const input = (part.input ?? {}) as LsInput
  // Re-split only when the raw output changes; a large directory listing is
  // otherwise re-split on every streaming token of the surrounding message.
  const lines = useMemo(() => {
    const output = typeof part.output === "string" ? part.output : ""
    return output.split(/\r?\n/).filter(Boolean)
  }, [part.output])
  // First output line is the resolved directory path; the rest are entries.
  const entries = useMemo(() => lines.slice(1), [lines])
  // A huge directory listing clamps to a row budget — same convention as the
  // glob/grep result lists.
  const clamp = useClampedRows(entries, TOOL_LIST_MAX_ROWS)
  // Pending calls have no listing yet; a directory that genuinely has no
  // entries still arrives as a one-line output (the dir itself).
  if (lines.length === 0 && !input.path) return null
  if (typeof part.output !== "string") return null

  return (
    <div className="min-w-0" data-testid="mcp-ls-card">
      {/* The row already states the directory as its target — the body
          carries only the entry list. */}
      {entries.length === 0 ? (
        <p className="text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul
          className="max-h-60 overflow-auto rounded border bg-muted/30 px-2 py-1 font-mono text-[11px]"
          data-testid="mcp-ls-list"
        >
          {clamp.visible.map((e, i) => {
            // `ls` marks directories with a trailing slash.
            const isDir = /[/\\]$/.test(e)
            return (
              <li key={i} data-testid="mcp-ls-entry" className="flex items-center gap-1.5">
                <FileTypeIcon path={isDir ? e.slice(0, -1) : e} isDir={isDir} className="size-3" />
                <span className="min-w-0 truncate">{e}</span>
              </li>
            )
          })}
        </ul>
      )}
      {clamp.hidden > 0 && (
        <PreviewClampNote
          shown={clamp.shown}
          total={clamp.total}
          onExpand={clamp.reveal}
          testId="mcp-ls-clamped"
        />
      )}
    </div>
  )
}
