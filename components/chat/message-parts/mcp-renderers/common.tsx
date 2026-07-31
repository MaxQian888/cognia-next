"use client"

/**
 * Shared helpers for the structured MCP / built-in tool cards.
 *
 * Each tool returns its payload as a `ToolUIPart.output` value — sometimes
 * a string (MCP protocol returns text blocks), sometimes an object (Claude
 * SDK normalizes select tools). These helpers wrap the unstable parsing so
 * every card has the same fall-through behaviour: if the payload doesn't
 * parse, the card returns `null` and the renderer falls back to the
 * generic ToolBody.
 */

import { useMemo, type ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { McpResultBlock } from "@/lib/claude/parts-extensions"

export function parseOutputJson(output: unknown): unknown | null {
  if (output === null || output === undefined) return null
  if (typeof output === "string") {
    const trimmed = output.trim()
    if (!trimmed) return null
    try {
      return JSON.parse(trimmed)
    } catch {
      return null
    }
  }
  if (typeof output === "object") return output
  return null
}

export function useParsedOutput<T>(output: unknown): T | null {
  return useMemo(() => parseOutputJson(output) as T | null, [output])
}

/**
 * Extract the hostname from a URL for the compact card badges. Falls back to
 * the raw string when the value isn't a parseable URL. Shared by the WebFetch
 * and WebSearch cards (previously duplicated verbatim in both).
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * Canonical file-extension → syntax-highlighting language map. Hoisted to
 * module scope so it isn't reallocated on every render, and shared by the
 * Read / Write cards (which previously kept two separately-drifting copies —
 * this superset is a strict union of both so neither card loses a mapping).
 */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  rb: "ruby",
  cs: "csharp",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  md: "markdown",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  css: "css",
  html: "html",
  sh: "bash",
  sql: "sql",
}

export function languageFromPath(path: string | undefined): string {
  if (!path) return "text"
  const ext = path.toLowerCase().split(".").pop() ?? ""
  return LANGUAGE_BY_EXT[ext] ?? "text"
}

/**
 * Build a usable `src` (data URL) from an image/audio block in either wire
 * shape — MCP's `{ data, mimeType }` or Anthropic's
 * `{ source: { data, media_type } }`. Returns null when the block carries no
 * payload. Shared by the generic blocks card and the Read card, which both
 * render images off `part.mcpContent`.
 */
export function blockMediaSrc(block: McpResultBlock, fallbackMime: string): string | null {
  const b = block as {
    data?: unknown
    mimeType?: unknown
    source?: { data?: unknown; media_type?: unknown }
  }
  if (typeof b.data === "string" && b.data.length > 0) {
    const mime = typeof b.mimeType === "string" ? b.mimeType : fallbackMime
    return b.data.startsWith("data:") ? b.data : `data:${mime};base64,${b.data}`
  }
  const src = b.source
  if (src && typeof src.data === "string" && src.data.length > 0) {
    const mime = typeof src.media_type === "string" ? src.media_type : fallbackMime
    return src.data.startsWith("data:") ? src.data : `data:${mime};base64,${src.data}`
  }
  return null
}

export function McpCardShell({
  title,
  badge,
  action,
  children,
  className,
  testId,
}: {
  title: string
  badge?: string
  /** Optional right-aligned header control (e.g. an "open in review" button). */
  action?: ReactNode
  children: ReactNode
  className?: string
  testId: string
}) {
  return (
    <div
      data-testid={testId}
      className={cn("my-2 rounded-md border bg-card text-card-foreground", className)}
    >
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
        <span className="font-medium text-xs">{title}</span>
        <div className="flex items-center gap-1">
          {badge && (
            <Badge variant="outline" className="text-[10px]" data-testid={`${testId}-badge`}>
              {badge}
            </Badge>
          )}
          {action}
        </div>
      </div>
      <div className="space-y-1 px-3 py-2 text-xs">{children}</div>
    </div>
  )
}
