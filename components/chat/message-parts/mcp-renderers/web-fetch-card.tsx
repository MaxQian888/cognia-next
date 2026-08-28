"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, GlobeIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { McpCardShell, hostOf, useParsedOutput } from "./common"
import { ExternalLink } from "@/components/shared/external-link"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { unwrapUntrustedContent } from "@/lib/web/untrusted-content"

interface WebFetchInput {
  url?: string
  prompt?: string
}

interface WebFetchOutput {
  ok?: boolean
  error?: string
  status?: number
  url?: string
  title?: string
  contentType?: string
  content?: string
  text?: string
  result?: string
  body?: string
  note?: string
}

const FETCH_PREVIEW_CHARS = 600

/**
 * Renderer for the Claude built-in `WebFetch` tool: the fetched URL (clickable),
 * the optional extraction prompt, and a scrollable preview of the returned
 * content. Returns `null` (→ generic ToolBody) when no URL is present.
 */
export function WebFetchCard({ part }: { part: ToolUIPart }) {
  const t = useTranslations("chat.toolCards.webFetch")
  const input = (part.input ?? {}) as WebFetchInput
  const parsed = useParsedOutput<WebFetchOutput>(part.output)
  const [expanded, setExpanded] = useState(false)
  const url = parsed?.url ?? input.url

  const content = useMemo(() => {
    const candidate =
      parsed?.content ??
      parsed?.text ??
      parsed?.result ??
      parsed?.body ??
      parsed?.note ??
      (typeof part.output === "string" ? part.output : "")
    return typeof candidate === "string" ? unwrapUntrustedContent(candidate) : ""
  }, [parsed, part.output])
  const isLong = content.length > FETCH_PREVIEW_CHARS
  const preview = expanded || !isLong ? content : `${content.slice(0, FETCH_PREVIEW_CHARS)}…`

  // `ok` mirrors the HTTP outcome, not "did the tool run": a 404 resolves with
  // `ok: false` AND a `status`, and its body/note are still worth showing. A
  // structured tool failure is the one with no `status` at all — keying this
  // branch on `ok` alone turned every 4xx/5xx into a bare "failed" card that
  // hid the status code and the response the fetch did retrieve.
  const isHttpOutcome = typeof parsed?.status === "number"
  if (!isHttpOutcome && (parsed?.ok === false || parsed?.error)) {
    return (
      <McpCardShell
        title={t("title")}
        badge={url ? hostOf(url) : undefined}
        testId="mcp-webfetch-card"
      >
        <p className="text-destructive" data-testid="mcp-webfetch-error">
          {parsed.error ?? t("failed")}
        </p>
      </McpCardShell>
    )
  }
  if (!url) return null

  return (
    <McpCardShell
      title={t("title")}
      badge={
        typeof parsed?.status === "number"
          ? t("status", { status: parsed.status })
          : url
            ? hostOf(url)
            : undefined
      }
      testId="mcp-webfetch-card"
    >
      <div className="flex items-start gap-2">
        <GlobeIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          {parsed?.title && (
            <p className="truncate text-[12px] font-medium" data-testid="mcp-webfetch-title">
              {unwrapUntrustedContent(parsed.title)}
            </p>
          )}
          {url && (
            <ExternalLink
              href={url}
              className="block break-all font-mono text-[11px] text-primary hover:underline"
              data-testid="mcp-webfetch-url"
            >
              {url}
            </ExternalLink>
          )}
          {input.prompt && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">{input.prompt}</p>
          )}
          {parsed?.contentType && (
            <span className="text-[10px] text-muted-foreground">{parsed.contentType}</span>
          )}
          {preview ? (
            <>
              <pre
                className={cn(
                  "whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-sans text-[11px] leading-relaxed",
                  !expanded && isLong && "max-h-40 overflow-hidden"
                )}
                data-testid="mcp-webfetch-content"
              >
                {preview}
              </pre>
              {isLong && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-[11px]"
                  aria-expanded={expanded}
                  onClick={() => setExpanded((value) => !value)}
                >
                  <ChevronDownIcon
                    className={cn("size-3 transition-transform", expanded && "rotate-180")}
                    aria-hidden
                  />
                  {expanded ? t("showLess") : t("showMore", { chars: content.length })}
                </Button>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">{t("empty")}</p>
          )}
        </div>
      </div>
    </McpCardShell>
  )
}
