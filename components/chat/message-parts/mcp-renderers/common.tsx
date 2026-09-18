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

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import type { McpResultBlock } from "@/lib/claude/parts-extensions"
import { cn } from "@/lib/utils"

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

/** Deterministic letter-chip hues for sources without a favicon. */
const FAVICON_PALETTE = [
  "bg-sky-600",
  "bg-emerald-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-violet-600",
  "bg-orange-600",
  "bg-teal-600",
  "bg-slate-600",
]

/**
 * A source's favicon when the provider payload ships one (`favicon` on
 * `SearchResult` — brave/serpapi/serper/searchapi fill it), else a letter
 * chip whose hue is hashed off the host. The favicon+domain pair is the
 * source identity in every search UI (Perplexity, ChatGPT, AI Overviews);
 * decorative only — the link text already carries the title.
 */
export function SourceFavicon({ src, host }: { src?: string; host: string }) {
  const [failed, setFailed] = useState(false)
  if (src && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- provider-supplied remote favicon; not an app asset
      <img
        src={src}
        alt=""
        aria-hidden
        loading="lazy"
        referrerPolicy="no-referrer"
        className="size-3.5 shrink-0 rounded-[3px]"
        onError={() => setFailed(true)}
      />
    )
  }
  let hash = 0
  for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] text-[9px] font-semibold text-white",
        FAVICON_PALETTE[hash % FAVICON_PALETTE.length]
      )}
    >
      {host.charAt(0).toUpperCase() || "?"}
    </span>
  )
}

/** `publishedDate` rendered as `YYYY-MM-DD` when it parses; null otherwise. */
export function dateOf(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null
  return Number.isNaN(Date.parse(value)) ? null : value.slice(0, 10)
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
 * Preview budgets for tool payloads expanded inside a chat row. An unbounded
 * dump is both a DOM cost (Shiki highlighting, per-row workbench links,
 * intraline diffs) and a scroll wall — bodies render at most this many
 * lines/rows and collapse the rest behind a "show all" note. Escape hatches
 * after reveal: CodeBlock's own line cap + fullscreen, and the workbench link.
 */
export const TOOL_PREVIEW_MAX_LINES = 120
export const TOOL_LIST_MAX_ROWS = 200
export const TOOL_PREVIEW_MAX_EDITS = 20

export interface ClampedRows<T> {
  /** Rows to render — the full list once revealed, else the first `max`. */
  visible: readonly T[]
  total: number
  shown: number
  /** Rows currently hidden behind the clamp note; 0 once revealed. */
  hidden: number
  /** True after the user revealed the full list. */
  revealed: boolean
  reveal: () => void
}

/**
 * Clamp a row list to a preview budget with a show-all escape. Pass a stable
 * or memoized `items` array — `visible` re-slices only when inputs change.
 */
export function useClampedRows<T>(
  items: readonly T[],
  max = TOOL_PREVIEW_MAX_LINES
): ClampedRows<T> {
  const [revealed, setRevealed] = useState(false)
  const hidden = revealed ? 0 : Math.max(0, items.length - max)
  const visible = useMemo(() => (hidden > 0 ? items.slice(0, max) : items), [items, hidden, max])
  return {
    visible,
    total: items.length,
    shown: visible.length,
    hidden,
    revealed,
    reveal: () => setRevealed(true),
  }
}

/**
 * "Showing the first {shown} of {total} · Show all" footer under a clamped
 * tool payload. Render only while `hidden > 0` — the note has no expanded
 * state because revealing hands the payload to the component's own full view
 * (CodeBlock's cap/fullscreen, the diff's scroll box, …).
 */
export function PreviewClampNote({
  shown,
  total,
  onExpand,
  hint,
  testId,
}: {
  shown: number
  total: number
  onExpand: () => void
  /** Optional trailing context, e.g. "full content is on disk". */
  hint?: string
  testId?: string
}) {
  const t = useTranslations("chat.toolRow.preview")
  return (
    <p
      className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground"
      data-testid={testId}
    >
      <span>
        {t("truncated", { shown, total })}
        {hint ? ` ${hint}` : null}
      </span>
      <button
        type="button"
        onClick={onExpand}
        className="font-medium text-primary hover:underline"
        data-testid={testId ? `${testId}-show-all` : undefined}
      >
        {t("showAll")}
      </button>
    </p>
  )
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
