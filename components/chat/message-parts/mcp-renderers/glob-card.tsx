"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { FileSearchIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { McpCardShell, useParsedOutput } from "./common"
import { WorkbenchFileLink } from "./workbench-file-link"

interface GlobOutput {
  matches?: string[]
  files?: string[]
}

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

  if (matches.length === 0 && !input.pattern) return null

  return (
    <McpCardShell
      title={/* i18n-exempt: the tool's own name, identical in every locale */ "Glob"}
      badge={input.pattern ?? `${matches.length} matches`}
      testId="mcp-glob-card"
    >
      <div className="flex items-start gap-2">
        <FileSearchIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {input.pattern && (
            <p
              className="font-mono text-[11px] text-muted-foreground"
              data-testid="mcp-glob-pattern"
            >
              {input.pattern}
              {input.path && ` · in ${input.path}`}
            </p>
          )}
          {matches.length === 0 ? (
            <p className="text-muted-foreground">{t("noMatches")}</p>
          ) : (
            <ul
              className="mt-1 max-h-60 overflow-auto rounded border bg-muted/30 px-2 py-1 font-mono text-[11px]"
              data-testid="mcp-glob-list"
            >
              {matches.map((m, i) => (
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
        </div>
      </div>
    </McpCardShell>
  )
}
