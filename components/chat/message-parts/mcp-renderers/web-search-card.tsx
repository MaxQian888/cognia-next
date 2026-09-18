"use client"

import { useTranslations } from "next-intl"
import type { ToolUIPart } from "ai"
import {
  dateOf,
  hostOf,
  PreviewClampNote,
  SourceFavicon,
  useClampedRows,
  useParsedOutput,
} from "./common"
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
  favicon?: string
  publishedDate?: string
}

/**
 * Only the first few hits render by default — a search page can return a
 * dozen results, and the row's expand is about scanning the top matches, not
 * reading a directory. The rest fold behind the shared clamp note.
 */
const SEARCH_RESULT_PREVIEW_ROWS = 5

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
 * Renderer for the Claude built-in `WebSearch` tool. The row above already
 * carries the query and match count, so the body is a bare source list — the
 * favicon+domain pair is the source identity (same convention as Perplexity /
 * ChatGPT source lists): one title line per result, a single clamped snippet
 * line under it, and the provider answer as a quote rail on top. Returns
 * `null` (→ generic ToolBody) when neither a query nor results are present.
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
  // A long result page folds after the preview rows — same convention as the
  // other search bodies, just with a much tighter default budget.
  const clamped = useClampedRows(results, SEARCH_RESULT_PREVIEW_ROWS)

  if (parsed?.ok === false || parsed?.error) {
    return (
      <div data-testid="mcp-websearch-card" className="my-1 text-xs">
        <p className="text-destructive" data-testid="mcp-websearch-error">
          {parsed.error ?? t("failed")}
        </p>
      </div>
    )
  }
  if (results.length === 0 && (!query || parsed == null)) return null

  return (
    <div data-testid="mcp-websearch-card" className="my-1 space-y-0.5 text-xs">
      {parsed?.answer && (
        <p
          className="mb-1 border-l-2 border-border py-0.5 pl-2.5 text-[11.5px] leading-relaxed text-foreground/80"
          data-testid="mcp-websearch-answer"
        >
          {unwrapUntrustedContent(parsed.answer)}
        </p>
      )}
      {results.length === 0 ? (
        <p className="text-muted-foreground">{t("noResults")}</p>
      ) : (
        <ul className="space-y-0.5" data-testid="mcp-websearch-list">
          {clamped.visible.map((r, i) => {
            const host = r.url ? hostOf(r.url) : ""
            const snippet = r.content ?? r.snippet ?? r.description
            const date = dateOf(r.publishedDate)
            return (
              <li
                key={`${r.url ?? r.title ?? "result"}-${i}`}
                data-testid="mcp-websearch-result"
                className="min-w-0"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <SourceFavicon src={r.favicon} host={host} />
                  {r.url ? (
                    <ExternalLink
                      href={r.url}
                      className="block min-w-0 truncate text-[12px] font-medium text-primary hover:underline"
                      preferEmbedded
                    >
                      {r.title ? unwrapUntrustedContent(r.title) : r.url}
                    </ExternalLink>
                  ) : (
                    <span className="block min-w-0 truncate text-[12px] font-medium">
                      {r.title ? unwrapUntrustedContent(r.title) : host}
                    </span>
                  )}
                  {host && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">· {host}</span>
                  )}
                  {date && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">· {date}</span>
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
                {snippet && (
                  <p className="line-clamp-1 pl-5 text-[11px] text-muted-foreground">
                    {unwrapUntrustedContent(snippet)}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {clamped.hidden > 0 && (
        <div className="pl-5">
          <PreviewClampNote
            shown={clamped.shown}
            total={clamped.total}
            onExpand={clamped.reveal}
            testId="mcp-websearch-clamped"
          />
        </div>
      )}
    </div>
  )
}
