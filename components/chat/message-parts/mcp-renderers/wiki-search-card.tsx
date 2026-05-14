"use client"

import { BookOpenIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { McpCardShell, useParsedOutput } from "./common"

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
  const parsed = useParsedOutput<WikiSearchOutput>(part.output)
  if (!parsed || !Array.isArray(parsed.hits)) return null

  return (
    <McpCardShell
      title="wiki_search"
      badge={`${parsed.hits.length} hits`}
      testId="mcp-wiki-search-card"
    >
      {parsed.hits.length === 0 ? (
        <p className="text-muted-foreground">No results.</p>
      ) : (
        <ul className="space-y-1">
          {parsed.hits.map((hit, i) => (
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
      )}
    </McpCardShell>
  )
}
