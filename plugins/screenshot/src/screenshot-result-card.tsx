"use client"

/**
 * Rich chat card for the screenshot plugin's `take_screenshot` tool
 * (ADR-0127: first-party registration for the plugin tool-result registry).
 *
 * The tool returns MCP-style content blocks (`text` note + `image`); the host
 * would already paint them through its generic blocks card, but this card
 * shows the capture as the thing it is — a thumbnail with its filename / size
 * caption and the "copied to clipboard" state — and reuses the host's image
 * block so the lightbox / lazy-load behaviour matches every other image in
 * the transcript. Returns `null` when no image block is present.
 *
 * The text block is a JSON `ScreenshotCaption`; the card localizes it at
 * render time from the plugin's own `manifest.i18n` bundle. A plain-text
 * block (transcripts written before the caption was structured) is shown as
 * it was stored.
 */

import { CameraIcon } from "lucide-react"

import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import {
  blockMediaSrc,
  type McpResultBlock,
  type ToolResultRendererProps,
} from "@cognia/plugin-sdk/api/tool-renderer"
import type { MessagePartRendererProps } from "@cognia/plugin-sdk/api/message-renderer"
import { parseToolOutput, PluginImage, ToolCard } from "@cognia/plugin-ui"

/**
 * The custom `UIMessage` part type the `/screenshot` command appends via
 * `ctx.chat.appendMessagePart`. Carries the same MCP content blocks the
 * `take_screenshot` tool emits, so this card renders both.
 */
export const SCREENSHOT_PART_TYPE = "screenshot-result"

export const PLUGIN_ID = "cognia-screenshot"

/** The structured caption the capture's text block carries (JSON). */
export interface ScreenshotCaption {
  ok: true
  filename: string
  /** Encoded byte size. */
  size: number
  mimeType: string
  copiedToClipboard: boolean
}

/** Human-readable byte size for the caption / command reply ("1.2 MB"). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Parse a text block as a `ScreenshotCaption`, or `null` for any other text. */
export function parseScreenshotCaption(text: string): ScreenshotCaption | null {
  try {
    const value = JSON.parse(text) as Partial<ScreenshotCaption> | null
    if (
      value &&
      typeof value === "object" &&
      typeof value.filename === "string" &&
      typeof value.size === "number"
    ) {
      return {
        ok: true,
        filename: value.filename,
        size: value.size,
        mimeType: typeof value.mimeType === "string" ? value.mimeType : "image/png",
        copiedToClipboard: value.copiedToClipboard === true,
      }
    }
  } catch {
    // Not JSON — a legacy plain-text note.
  }
  return null
}
/** Structural view of a content block — `McpResultBlock`'s catch-all member keeps union narrowing from helping, so cards read `type`/`text` this way. */
export interface ContentBlockLike {
  type?: string
  text?: string
}

/** Pull the content blocks off either wire shape (`mcpContent` or `output.content`). */
export function screenshotBlocks(part: unknown): McpResultBlock[] {
  const p = part as { mcpContent?: unknown; output?: unknown }
  if (Array.isArray(p.mcpContent)) return p.mcpContent as McpResultBlock[]
  const parsed = parseToolOutput(p.output) as { content?: unknown } | null
  if (parsed && Array.isArray(parsed.content)) return parsed.content as McpResultBlock[]
  return []
}

export function ScreenshotResultCard({ part }: ToolResultRendererProps) {
  const t = usePluginTranslations(PLUGIN_ID)
  const blocks = screenshotBlocks(part)
  const image = blocks.find((b) => (b as ContentBlockLike).type === "image")
  const src = image ? blockMediaSrc(image, "image/png") : null
  if (!src) return null
  const note = blocks
    .filter((b): b is McpResultBlock & { text: string } => {
      const c = b as ContentBlockLike
      return c.type === "text" && typeof c.text === "string" && c.text.trim().length > 0
    })
    .map((b) => {
      const caption = parseScreenshotCaption(b.text)
      if (!caption) return b.text
      const base = t("card.note", { filename: caption.filename, size: formatSize(caption.size) })
      return caption.copiedToClipboard ? `${base} ${t("card.copied")}` : base
    })
    .join(" ")

  return (
    <ToolCard title={t("card.title")} testId="screenshot-result-card">
      <div className="flex items-start gap-2">
        <CameraIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="max-w-md">
            <PluginImage src={src} alt={t("card.alt")} />
          </div>
          {note && (
            <p
              className="break-words text-[11px] text-muted-foreground"
              data-testid="screenshot-result-note"
            >
              {note}
            </p>
          )}
        </div>
      </div>
    </ToolCard>
  )
}

/**
 * Renders the `screenshot-result` message part the `/screenshot` slash
 * command appends to the transcript. The part carries `mcpContent` blocks,
 * which is the first shape `screenshotBlocks` looks for, so the tool card
 * draws it unchanged.
 */
export function ScreenshotMessagePart({ part }: MessagePartRendererProps) {
  return <ScreenshotResultCard part={part as ToolResultRendererProps["part"]} />
}
