"use client"

import { useTranslations } from "next-intl"
import { BookOpenIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { PreviewClampNote, TOOL_LIST_MAX_ROWS, useClampedRows, useParsedOutput } from "./common"

interface WikiHit {
  slug: string
  title: string
  score?: number
  excerpt?: string
}

interface WikiSearchOutput {
  hits?: WikiHit[]
}

export function WikiSearchCard({ part }: { part: ToolUIPart }) {
  const t = useTranslations("chat.mcp.wikiSearch")
  const parsed = useParsedOutput<WikiSearchOutput>(part.output)
  const clamped = useClampedRows(
    parsed && Array.isArray(parsed.hits) ? parsed.hits : [],
    TOOL_LIST_MAX_ROWS
  )
  if (!parsed || !Array.isArray(parsed.hits)) return null

  return (
    <div data-testid="mcp-wiki-search-card" className="my-1 text-xs">
      {clamped.total === 0 ? (
        <p className="text-muted-foreground">{t("noResults")}</p>
      ) : (
        <>
          <ul className="space-y-1">
            {clamped.visible.map((hit, i) => (
              <li
                key={hit.slug || i}
                className="flex items-start gap-2"
                data-testid="mcp-wiki-search-row"
                data-slug={hit.slug}
              >
                <BookOpenIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{hit.title}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{hit.slug}</span>
                    {typeof hit.score === "number" && (
                      <span
                        className="text-[10px] text-muted-foreground"
                        data-testid="mcp-wiki-search-score"
                      >
                        {hit.score.toFixed(2)}
                      </span>
                    )}
                  </div>
                  {hit.excerpt && (
                    <span className="line-clamp-2 text-muted-foreground">{hit.excerpt}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {clamped.hidden > 0 && (
            <PreviewClampNote
              shown={clamped.shown}
              total={clamped.total}
              onExpand={clamped.reveal}
              testId="mcp-wiki-search-clamped"
            />
          )}
        </>
      )}
    </div>
  )
}
