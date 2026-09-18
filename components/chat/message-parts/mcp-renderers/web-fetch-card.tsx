"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import type { ToolUIPart } from "ai"
import { useParsedOutput } from "./common"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { InlineCopyButton } from "@/components/chat/message-parts/tool-row"
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

function looksLikeJsonPayload(s: string): boolean {
  const trimmed = s.trim()
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  )
}

/**
 * Renderer for the Claude built-in `WebFetch` tool. The row above already
 * carries the URL and HTTP status, so the body only adds what it can't: the
 * page title, the extraction prompt, a redirect notice when the final URL
 * differs from the requested one, and the fetched content.
 *
 * Content is surface-free — a hairline left rail groups the prose, which is
 * markdown-rendered and fades out past the preview budget. JSON-ish payloads
 * (API responses) render as a compact code block instead; binary payloads
 * collapse to a single meta line rather than dumping base64.
 *
 * Returns `null` (→ generic ToolBody) when no URL is present.
 */
export function WebFetchCard({ part }: { part: ToolUIPart }) {
  const t = useTranslations("chat.toolCards.webFetch")
  const tRow = useTranslations("chat.toolRow")
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
  const preview = expanded || !isLong ? content : content.slice(0, FETCH_PREVIEW_CHARS)

  // `ok` mirrors the HTTP outcome, not "did the tool run": a 404 resolves with
  // `ok: false` AND a `status`, and its body/note are still worth showing. A
  // structured tool failure is the one with no `status` at all — keying this
  // branch on `ok` alone turned every 4xx/5xx into a bare "failed" card that
  // hid the status code and the response the fetch did retrieve.
  const isHttpOutcome = typeof parsed?.status === "number"
  if (!isHttpOutcome && (parsed?.ok === false || parsed?.error)) {
    return (
      <div data-testid="mcp-webfetch-card" className="my-1 text-xs">
        <p className="text-destructive" data-testid="mcp-webfetch-error">
          {parsed.error ?? t("failed")}
        </p>
      </div>
    )
  }
  if (!url) return null

  const redirected = Boolean(parsed?.url && input.url && parsed.url !== input.url)
  const contentType = parsed?.contentType
  const jsonPayload = (contentType?.includes("json") ?? false) || looksLikeJsonPayload(content)
  const textual =
    !contentType ||
    contentType.startsWith("text/") ||
    /json|xml|html|markdown|javascript/.test(contentType)

  return (
    <div data-testid="mcp-webfetch-card" className="my-1 space-y-0.5 text-xs">
      {redirected && (
        <p
          className="text-[11px] text-amber-600 dark:text-amber-400"
          data-testid="mcp-webfetch-redirect"
        >
          {t("redirectedTo", { url: parsed?.url ?? "" })}
        </p>
      )}
      {(parsed?.title || input.prompt) && (
        <p className="flex items-baseline gap-1.5 text-[12px] leading-snug">
          {parsed?.title && (
            <span className="font-medium" data-testid="mcp-webfetch-title">
              {unwrapUntrustedContent(parsed.title)}
            </span>
          )}
          {input.prompt && (
            <span
              className="min-w-0 truncate text-muted-foreground"
              data-testid="mcp-webfetch-prompt"
            >
              {parsed?.title ? "· " : ""}
              {input.prompt}
            </span>
          )}
        </p>
      )}
      {!content ? (
        <p className="text-[11px] text-muted-foreground">{t("empty")}</p>
      ) : jsonPayload ? (
        <CodeBlock
          code={content}
          language="json"
          showLineNumbers={false}
          compact
          headerTitle={t("content")}
        />
      ) : !textual ? (
        <p className="text-[11px] text-muted-foreground" data-testid="mcp-webfetch-binary">
          {contentType} · {t("chars", { count: content.length })}
        </p>
      ) : (
        <>
          <div className="group/wf relative border-l-2 border-border pl-2.5">
            <span className="absolute right-0 top-0 z-10 opacity-0 transition-opacity focus-within:opacity-100 group-hover/wf:opacity-100">
              <InlineCopyButton
                value={content}
                label={tRow("copyOutput")}
                testId="mcp-webfetch-copy"
              />
            </span>
            <div
              className={cn(
                "text-[11.5px] leading-relaxed text-foreground/80",
                expanded
                  ? "max-h-56 overflow-auto"
                  : isLong &&
                      "max-h-32 overflow-hidden [mask-image:linear-gradient(#000_55%,transparent)]"
              )}
              data-testid="mcp-webfetch-content"
            >
              <MarkdownRenderer
                content={preview}
                rhythm="chat"
                enableMermaid={false}
                enableMath={false}
                enableDiff={false}
                enableAlerts={false}
                enableEnhancedImages={false}
                enableVideoEmbed={false}
                enableAudioEmbed={false}
                showLineNumbers={false}
              />
            </div>
          </div>
          {isLong && !expanded && (
            <p
              className="flex items-center gap-2 pt-0.5 pl-3 text-[10px] text-muted-foreground"
              data-testid="mcp-webfetch-clamped"
            >
              <span>
                {t("truncatedChars", { shown: FETCH_PREVIEW_CHARS, total: content.length })}
              </span>
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="font-medium text-primary hover:underline"
                data-testid="mcp-webfetch-show-all"
              >
                {tRow("preview.showAll")}
              </button>
            </p>
          )}
        </>
      )}
    </div>
  )
}
