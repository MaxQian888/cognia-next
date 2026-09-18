"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import type { ToolUIPart } from "ai"
import { PreviewClampNote, TOOL_LIST_MAX_ROWS, useClampedRows, useParsedOutput } from "./common"
import { WorkbenchFileLink } from "./workbench-file-link"

interface GlobOutput {
  matches?: string[]
  files?: string[]
}

/**
 * Body content for a `glob` call — pattern context + a scrollable list of
 * matched paths (each workbench-linkable). Rendered bare: the surrounding row
 * owns the card chrome now.
 */
export function GlobCard({ part, sessionId }: { part: ToolUIPart; sessionId?: string }) {
  const t = useTranslations("chat.mcp.glob")
  const input = (part.input ?? {}) as { pattern?: string; path?: string }
  const parsed = useParsedOutput<GlobOutput>(part.output)

  // Select (and, on the string fallback, split) the match list only when the
  // parsed/raw output changes rather than on every streaming re-render.
  const matches: string[] = useMemo(() => {
    if (parsed?.matches) return parsed.matches
    if (parsed?.files) return parsed.files
    if (typeof part.output === "string") {
      return part.output.split(/\r?\n/).filter(Boolean)
    }
    return []
  }, [parsed, part.output])
  // Every match mounts a WorkbenchFileLink; a huge glob result clamps to a
  // row budget instead of flooding the expansion with thousands of links.
  const clamp = useClampedRows(matches, TOOL_LIST_MAX_ROWS)

  if (matches.length === 0 && !input.pattern) return null

  return (
    <div className="min-w-0" data-testid="mcp-glob-card">
      {/* The row already states pattern + scope as its target — the body
          carries only the matched file list. */}
      {matches.length === 0 ? (
        <p className="text-muted-foreground">{t("noMatches")}</p>
      ) : (
        <ul
          className="max-h-60 overflow-auto rounded border bg-muted/30 px-2 py-1 font-mono text-[11px]"
          data-testid="mcp-glob-list"
        >
          {clamp.visible.map((m, i) => (
            <li key={i} data-testid="mcp-glob-match" className="truncate">
              <WorkbenchFileLink
                sessionId={sessionId}
                path={m}
                className="block truncate"
                data-testid="mcp-glob-match-link"
              />
            </li>
          ))}
        </ul>
      )}
      {clamp.hidden > 0 && (
        <PreviewClampNote
          shown={clamp.shown}
          total={clamp.total}
          onExpand={clamp.reveal}
          testId="mcp-glob-clamped"
        />
      )}
    </div>
  )
}
