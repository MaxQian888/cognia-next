"use client"

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
  const parsed = useParsedOutput<RagSearchOutput>(part.output)
  if (!parsed || !Array.isArray(parsed.hits)) return null

  return (
    <McpCardShell
      title="rag_search"
      badge={`${parsed.hits.length} chunks`}
      testId="mcp-rag-search-card"
    >
      {parsed.hits.length === 0 ? (
        <p className="text-muted-foreground">No matches.</p>
      ) : (
        <ul className="space-y-2">
          {parsed.hits.map((hit, i) => (
            <li
              key={hit.id || i}
              className="flex items-start gap-2"
              data-testid="mcp-rag-search-row"
              data-id={hit.id}
            >
              <FileSearchIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-2">
                  {hit.sourceTitle && (
                    <span className="truncate font-medium">{hit.sourceTitle}</span>
                  )}
                  {hit.scope && (
                    <Badge variant="secondary" className="text-[10px]">
                      {hit.scope}
                    </Badge>
                  )}
                  {typeof hit.score === "number" && (
                    <span
                      className="ml-auto font-mono text-[10px] text-muted-foreground"
                      data-testid="mcp-rag-search-score"
                    >
                      {hit.score.toFixed(2)}
                    </span>
                  )}
                </div>
                {hit.content && <p className="line-clamp-3 text-muted-foreground">{hit.content}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </McpCardShell>
  )
}
