"use client"

import { useTranslations } from "next-intl"
import { FileSearchIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { McpCardShell, useParsedOutput } from "./common"

interface GlobOutput {
  matches?: string[]
  files?: string[]
}

export function GlobCard({ part }: { part: ToolUIPart }) {
  const t = useTranslations("chat.mcp.glob")
  const input = (part.input ?? {}) as { pattern?: string; path?: string }
  const parsed = useParsedOutput<GlobOutput>(part.output)

  const matches: string[] = (() => {
    if (parsed?.matches) return parsed.matches
    if (parsed?.files) return parsed.files
    if (typeof part.output === "string") {
      return part.output.split(/\r?\n/).filter(Boolean)
    }
    return []
  })()

  if (matches.length === 0 && !input.pattern) return null

  return (
    <McpCardShell
      title="Glob"
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
