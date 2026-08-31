"use client"

import { useTranslations } from "next-intl"
import { FileSearchIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { Badge } from "@/components/ui/badge"
import { McpCardShell, useParsedOutput } from "./common"

interface RagHit {
  id?: string
  content?: string
  score?: number
  sourceTitle?: string
  scope?: string
}

interface RagSearchOutput {
  hits?: RagHit[]
}

export function RagSearchCard({ part }: { part: ToolUIPart }) {
  const t = useTranslations("chat.mcp.ragSearch")
  const parsed = useParsedOutput<RagSearchOutput>(part.output)
  if (!parsed || !Array.isArray(parsed.hits)) return null

  return (
    <McpCardShell
      title={t("title")}
      badge={t("hitCount", { count: parsed.hits.length })}
      testId="mcp-rag-search-card"
    >
      {parsed.hits.length === 0 ? (
        <p className="text-muted-foreground">{t("noMatches")}</p>
      ) : (
        <ul className="space-y-2">
          {parsed.hits.map((hit, i) => (
            <li
              key={hit.id || i}
              className="flex min-w-0 items-start gap-2"
              data-testid="mcp-rag-search-row"
              data-id={hit.id}
            >
              <FileSearchIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  {hit.sourceTitle && (
                    <span className="min-w-0 max-w-full truncate font-medium">
                      {hit.sourceTitle}
                    </span>
                  )}
                  {hit.scope && (
                    <Badge variant="secondary" className="max-w-full truncate text-[10px]">
                      {hit.scope}
                    </Badge>
                  )}
                  {typeof hit.score === "number" && Number.isFinite(hit.score) && (
                    <span
                      className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground"
                      data-testid="mcp-rag-search-score"
                      aria-label={t("scoreLabel", { score: hit.score.toFixed(2) })}
                    >
                      {hit.score.toFixed(2)}
                    </span>
                  )}
                </div>
                {hit.content && (
                  <p className="line-clamp-3 break-words text-muted-foreground">{hit.content}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </McpCardShell>
  )
}
