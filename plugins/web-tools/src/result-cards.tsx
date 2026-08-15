"use client"

/**
 * Rich chat cards for the web-tools plugin's own tools (ADR-0127: the plugin
 * tool-result renderer registry had zero first-party registrations).
 *
 * `web_search` and `web_fetch` are NOT the Claude built-in `WebSearch` /
 * `WebFetch` tools — those keep the host's cards in
 * `components/chat/message-parts/mcp-renderers/`. These render the plugin's
 * own payload shapes from `lib/web/web-tools-core.ts` and reuse the host's
 * card shell + parsing helpers so they look like every other tool card.
 *
 * Both return `null` for a payload they cannot read; the host then falls back
 * to its generic tool body (see `mcp-tool-card.tsx`).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { GlobeIcon, SearchIcon, ChevronDownIcon } from "lucide-react"

import type { ToolResultRendererProps } from "@/lib/plugin/api/tool-result-renderers"
import {
  McpCardShell,
  hostOf,
  useParsedOutput,
} from "@/components/chat/message-parts/mcp-renderers/common"
import { ExternalLink } from "@/components/shared/external-link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface WebSearchResultRow {
  title?: string
  url?: string
  content?: string
  score?: number
  credibility?: string
}

interface WebSearchOutput {
  ok?: boolean
  error?: string
  query?: string
  provider?: string
  answer?: string | null
  results?: WebSearchResultRow[]
}

interface WebFetchOutput {
  ok?: boolean
  error?: string
  status?: number
  url?: string
  contentType?: string
  title?: string
  text?: string
}

/** Characters of extracted page text shown before "show more". */
export const FETCH_PREVIEW_CHARS = 600

export function WebSearchResultCard({ part }: ToolResultRendererProps) {
  const t = useTranslations("chat.toolCards.webSearch")
  const parsed = useParsedOutput<WebSearchOutput>((part as { output?: unknown }).output)
  const input = ((part as { input?: unknown }).input ?? {}) as { query?: string }
  const query = parsed?.query ?? input.query
  if (!parsed || (!Array.isArray(parsed.results) && !parsed.error && !query)) return null

  if (parsed.ok === false || parsed.error) {
    return (
      <McpCardShell title={t("title")} badge={query} testId="web-tools-search-card">
        <p className="text-destructive" data-testid="web-tools-search-error">
          {parsed.error ?? t("failed")}
        </p>
      </McpCardShell>
    )
  }

  const results = parsed.results ?? []
  return (
    <McpCardShell
      title={t("title")}
      badge={parsed.provider ? t("via", { provider: parsed.provider }) : undefined}
      testId="web-tools-search-card"
    >
      <div className="flex items-start gap-2">
        <SearchIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          {query && (
            <p className="text-[11px] text-muted-foreground" data-testid="web-tools-search-query">
              {query}
            </p>
          )}
          {parsed.answer && (
            <p
              className="rounded-md bg-muted/40 px-2 py-1.5 text-[12px] leading-relaxed"
              data-testid="web-tools-search-answer"
            >
              {parsed.answer}
            </p>
          )}
          {results.length === 0 ? (
            <p className="text-muted-foreground">{t("noResults")}</p>
          ) : (
            <ol className="space-y-1.5" data-testid="web-tools-search-results">
              {results.map((r, i) => (
                <li key={`${r.url ?? i}`} className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    {r.url ? (
                      <ExternalLink
                        href={r.url}
                        className="block truncate text-[12px] font-medium text-primary hover:underline"
                      >
                        {r.title ?? r.url}
                      </ExternalLink>
                    ) : (
                      <span className="block truncate text-[12px] font-medium">{r.title}</span>
                    )}
                    {r.credibility && (
                      <Badge
                        variant="outline"
                        className="h-4 shrink-0 px-1 text-[9px]"
                        data-testid="web-tools-search-credibility"
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
                  {r.content && (
                    <p className="line-clamp-2 text-[11px] text-muted-foreground">{r.content}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </McpCardShell>
  )
}

export function WebFetchResultCard({ part }: ToolResultRendererProps) {
  const t = useTranslations("chat.toolCards.webFetch")
  const parsed = useParsedOutput<WebFetchOutput>((part as { output?: unknown }).output)
  const input = ((part as { input?: unknown }).input ?? {}) as { url?: string }
  const [expanded, setExpanded] = useState(false)
  const url = parsed?.url ?? input.url
  if (!parsed || (!url && !parsed.error)) return null

  if (parsed.ok === false || parsed.error) {
    return (
      <McpCardShell
        title={t("title")}
        badge={url ? hostOf(url) : undefined}
        testId="web-tools-fetch-card"
      >
        <p className="text-destructive" data-testid="web-tools-fetch-error">
          {parsed.error ?? t("failed")}
        </p>
      </McpCardShell>
    )
  }

  const text = typeof parsed.text === "string" ? parsed.text : ""
  const isLong = text.length > FETCH_PREVIEW_CHARS
  const shown = expanded || !isLong ? text : `${text.slice(0, FETCH_PREVIEW_CHARS)}…`

  return (
    <McpCardShell
      title={t("title")}
      badge={typeof parsed.status === "number" ? t("status", { status: parsed.status }) : undefined}
      testId="web-tools-fetch-card"
    >
      <div className="flex items-start gap-2">
        <GlobeIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          {parsed.title && (
            <p className="truncate text-[12px] font-medium" data-testid="web-tools-fetch-title">
              {parsed.title}
            </p>
          )}
          {url && (
            <ExternalLink
              href={url}
              className="block truncate text-[11px] text-primary hover:underline"
            >
              {url}
            </ExternalLink>
          )}
          {parsed.contentType && (
            <span className="text-[10px] text-muted-foreground">{parsed.contentType}</span>
          )}
          {text && (
            <>
              <pre
                className={cn(
                  "whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-sans text-[11px] leading-relaxed",
                  !expanded && isLong && "max-h-40 overflow-hidden"
                )}
                data-testid="web-tools-fetch-text"
              >
                {shown}
              </pre>
              {isLong && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-[11px]"
                  aria-expanded={expanded}
                  onClick={() => setExpanded((v) => !v)}
                  data-testid="web-tools-fetch-toggle"
                >
                  <ChevronDownIcon
                    className={cn("size-3 transition-transform", expanded && "rotate-180")}
                    aria-hidden
                  />
                  {expanded ? t("showLess") : t("showMore", { chars: text.length })}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </McpCardShell>
  )
}
