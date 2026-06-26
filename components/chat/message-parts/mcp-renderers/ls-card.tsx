"use client"

// Structured card for the core `ls` tool — directory listing, reusing the
// GlobCard list layout.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { FolderOpenIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { McpCardShell } from "./common"

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
  const dir = lines[0] ?? input.path
  const entries = lines.slice(1)
  if (!dir) return null

  return (
    <McpCardShell title={t("title")} badge={dir} testId="mcp-ls-card">
      <div className="flex items-start gap-2">
        <FolderOpenIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] text-muted-foreground" data-testid="mcp-ls-path">
            {dir}
          </p>
          {entries.length === 0 ? (
            <p className="text-muted-foreground">{t("empty")}</p>
          ) : (
            <ul
              className="mt-1 max-h-60 overflow-auto rounded border bg-muted/30 px-2 py-1 font-mono text-[11px]"
              data-testid="mcp-ls-list"
            >
              {entries.map((e, i) => (
                <li key={i} data-testid="mcp-ls-entry" className="truncate">
                  {e}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </McpCardShell>
  )
}
