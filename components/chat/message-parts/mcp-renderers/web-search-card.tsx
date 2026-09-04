"use client"

import { useTranslations } from "next-intl"
import { SearchIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { McpCardShell, hostOf, useParsedOutput } from "./common"
import { ExternalLink } from "@/components/shared/external-link"
import { Badge } from "@/components/ui/badge"
import { unwrapUntrustedContent } from "@/lib/web/untrusted-content"

interface WebSearchInput {
  query?: string
}

interface SearchResult {
  title?: string
  url?: string
  snippet?: string
  description?: string
  content?: string
  credibility?: string
}

interface WebSearchOutput {
  ok?: boolean
  error?: string
  query?: string
  provider?: string
  answer?: string | null
  results?: SearchResult[]
  items?: SearchResult[]
}

/**
 * Renderer for the Claude built-in `WebSearch` tool: the query plus a list of
 * result rows (title link + host + snippet). Returns `null` (→ generic ToolBody)
 * when neither a query nor a parsable results array is present.
 */
export function WebSearchCard({ part }: { part: ToolUIPart }) {
  const t = useTranslations("chat.toolCards.webSearch")
  const input = (part.input ?? {}) as WebSearchInput
  const parsed = useParsedOutput<WebSearchOutput>(part.output)

  const results = Array.isArray(parsed?.results)
    ? parsed.results
    : Array.isArray(parsed?.items)
      ? parsed.items
      : []
  const query = parsed?.query ?? input.query

  if (parsed?.ok === false || parsed?.error) {
    return (
      <McpCardShell title={t("title")} badge={query} testId="mcp-websearch-card">
        <p className="text-destructive" data-testid="mcp-websearch-error">
          {parsed.error ?? t("failed")}
        </p>
      </McpCardShell>
    )
  }
  if (results.length === 0 && !query) return null

  return (
    <McpCardShell
      title={t("title")}
      badge={parsed?.provider ? t("via", { provider: parsed.provider }) : query}
      testId="mcp-websearch-card"
    >
      <div className="flex items-start gap-2">
        <SearchIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          {query && (
            <p className="text-[11px] text-muted-foreground" data-testid="mcp-websearch-query">
              {query}
            </p>
          )}
          {parsed?.answer && (
            <p
              className="rounded-md bg-muted/40 px-2 py-1.5 text-[12px] leading-relaxed"
              data-testid="mcp-websearch-answer"
            >
              {unwrapUntrustedContent(parsed.answer)}
            </p>
          )}
          {results.length === 0 ? (
            <p className="text-muted-foreground">{t("noResults")}</p>
          ) : (
            <ul className="mt-1 space-y-1.5" data-testid="mcp-websearch-list">
              {results.map((r, i) => (
                <li
                  key={`${r.url ?? r.title ?? "result"}-${i}`}
                  data-testid="mcp-websearch-result"
                  className="min-w-0"
                >
                  <div className="flex items-center gap-1.5">
                    {r.url ? (
                      <ExternalLink
                        href={r.url}
                        className="block truncate text-[12px] font-medium text-primary hover:underline"
                        preferEmbedded
                      >
                        {r.title ? unwrapUntrustedContent(r.title) : r.url}
                      </ExternalLink>
                    ) : (
                      <span className="block truncate text-[12px] font-medium">
                        {r.title ? unwrapUntrustedContent(r.title) : r.title}
                      </span>
                    )}
                    {r.credibility && (
                      <Badge
                        variant="outline"
                        className="h-4 shrink-0 px-1 text-[9px]"
                        data-testid="mcp-websearch-credibility"
                      >
                        {r.credibility}
                      </Badge>
                    )}
                  </div>
                  {r.url && (
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {hostOf(r.url)}
                    </span>
                  )}
                  {(r.content ?? r.snippet ?? r.description) && (
                    <p className="line-clamp-2 text-[11px] text-muted-foreground">
                      {unwrapUntrustedContent(r.content ?? r.snippet ?? r.description ?? "")}
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
