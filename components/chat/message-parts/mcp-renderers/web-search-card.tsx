"use client"

import { useTranslations } from "next-intl"
import { SearchIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { McpCardShell, hostOf, useParsedOutput } from "./common"

interface WebSearchInput {
  query?: string
}

interface SearchResult {
  title?: string
  url?: string
  snippet?: string
  description?: string
}

interface WebSearchOutput {
  results?: SearchResult[]
  items?: SearchResult[]
}

/**
 * Renderer for the Claude built-in `WebSearch` tool: the query plus a list of
 * result rows (title link + host + snippet). Returns `null` (→ generic ToolBody)
 * when neither a query nor a parsable results array is present.
 */
export function WebSearchCard({ part }: { part: ToolUIPart }) {
  const t = useTranslations("chat.mcp.webSearch")
  const input = (part.input ?? {}) as WebSearchInput
  const parsed = useParsedOutput<WebSearchOutput>(part.output)

  const results = parsed?.results ?? parsed?.items ?? []
  if (results.length === 0 && !input.query) return null

  return (
    <McpCardShell
      title="WebSearch"
      badge={input.query ?? `${results.length} results`}
      testId="mcp-websearch-card"
    >
      <div className="flex items-start gap-2">
        <SearchIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {input.query && (
            <p className="text-[11px] text-muted-foreground" data-testid="mcp-websearch-query">
              {input.query}
            </p>
          )}
          {results.length === 0 ? (
            <p className="text-muted-foreground">{t("noResults")}</p>
          ) : (
            <ul className="mt-1 space-y-1.5" data-testid="mcp-websearch-list">
              {results.map((r, i) => (
                <li key={i} data-testid="mcp-websearch-result" className="min-w-0">
                  {r.url ? (
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-[12px] text-primary hover:underline"
                    >
                      {r.title ?? r.url}
                    </a>
                  ) : (
                    <span className="block truncate text-[12px]">{r.title}</span>
                  )}
                  {r.url && (
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {hostOf(r.url)}
                    </span>
                  )}
                  {(r.snippet ?? r.description) && (
                    <p className="line-clamp-2 text-[11px] text-muted-foreground">
                      {r.snippet ?? r.description}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </McpCardShell>
  )
}
