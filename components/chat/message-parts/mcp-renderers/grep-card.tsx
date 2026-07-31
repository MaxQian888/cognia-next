"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { SearchIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { McpCardShell, useParsedOutput } from "./common"

interface GrepInput {
  pattern?: string
  path?: string
  glob?: string
  output_mode?: string
}

interface GrepOutput {
  matches?: string[]
  files?: string[]
  lines?: string[]
}

/**
 * Structured renderer for the Claude built-in `Grep` tool. Shows the pattern +
 * scope (path / glob / output mode) as context and the matched files or content
 * lines in a scrollable mono list. Mirrors {@link GlobCard}; falls through to the
 * generic ToolBody (by returning `null`) when there is neither a pattern nor any
 * parsable matches.
 */
export function GrepCard({ part }: { part: ToolUIPart }) {
  const t = useTranslations("chat.mcp.grep")
  const input = (part.input ?? {}) as GrepInput
  const parsed = useParsedOutput<GrepOutput>(part.output)

  // Selecting (and, on the string fallback, splitting) the match list is the
  // only non-trivial work here; recompute it only when the parsed output or the
  // raw payload changes rather than on every streaming re-render.
  const lines: string[] = useMemo(() => {
    if (parsed?.matches) return parsed.matches
    if (parsed?.lines) return parsed.lines
    if (parsed?.files) return parsed.files
    if (typeof part.output === "string") return part.output.split(/\r?\n/).filter(Boolean)
    return []
  }, [parsed, part.output])

  if (lines.length === 0 && !input.pattern) return null

  const scope = input.glob ?? input.path

  return (
    <McpCardShell
      title="Grep"
      badge={input.pattern ?? `${lines.length} matches`}
      testId="mcp-grep-card"
    >
      <div className="flex items-start gap-2">
        <SearchIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {input.pattern && (
            <p
              className="font-mono text-[11px] text-muted-foreground"
              data-testid="mcp-grep-pattern"
            >
              {input.pattern}
              {scope && ` · in ${scope}`}
              {input.output_mode && ` · ${input.output_mode}`}
            </p>
          )}
          {lines.length === 0 ? (
            <p className="text-muted-foreground">{t("noMatches")}</p>
          ) : (
            <ul
              className="mt-1 max-h-60 overflow-auto rounded border bg-muted/50 px-2 py-1 font-mono text-[11px]"
              data-testid="mcp-grep-list"
            >
              {lines.map((m, i) => (
                <li key={i} data-testid="mcp-grep-match" className="truncate">
                  {m}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </McpCardShell>
  )
}
