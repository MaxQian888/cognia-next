"use client"

import { useTranslations } from "next-intl"
import { GlobeIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { McpCardShell, useParsedOutput } from "./common"

interface WebFetchInput {
  url?: string
  prompt?: string
}

interface WebFetchOutput {
  content?: string
  text?: string
  result?: string
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * Renderer for the Claude built-in `WebFetch` tool: the fetched URL (clickable),
 * the optional extraction prompt, and a scrollable preview of the returned
 * content. Returns `null` (→ generic ToolBody) when no URL is present.
 */
export function WebFetchCard({ part }: { part: ToolUIPart }) {
  const t = useTranslations("chat.mcp.webFetch")
  const input = (part.input ?? {}) as WebFetchInput
  const parsed = useParsedOutput<WebFetchOutput>(part.output)

  if (!input.url) return null

  const content =
    parsed?.content ??
    parsed?.text ??
    parsed?.result ??
    (typeof part.output === "string" ? part.output : "")
  const preview = content.length > 2000 ? `${content.slice(0, 2000)}…` : content

  return (
    <McpCardShell title="WebFetch" badge={hostOf(input.url)} testId="mcp-webfetch-card">
      <div className="flex items-start gap-2">
        <GlobeIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <a
            href={input.url}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all font-mono text-[11px] text-primary hover:underline"
            data-testid="mcp-webfetch-url"
          >
            {input.url}
          </a>
          {input.prompt && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">{input.prompt}</p>
          )}
          {preview ? (
            <pre
              className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded border bg-muted/50 px-2 py-1 text-[11px] leading-relaxed"
              data-testid="mcp-webfetch-content"
            >
              {preview}
            </pre>
          ) : (
            <p className="text-muted-foreground">{t("empty")}</p>
          )}
        </div>
      </div>
    </McpCardShell>
  )
}
