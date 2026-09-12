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
 */

import { useTranslations } from "next-intl"
import { CameraIcon } from "lucide-react"

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
  const t = useTranslations("chat.toolCards.screenshot")
  const blocks = screenshotBlocks(part)
  const image = blocks.find((b) => (b as ContentBlockLike).type === "image")
  const src = image ? blockMediaSrc(image, "image/png") : null
  if (!src) return null
  const note = blocks
    .filter((b): b is McpResultBlock & { text: string } => {
      const c = b as ContentBlockLike
      return c.type === "text" && typeof c.text === "string" && c.text.trim().length > 0
    })
    .map((b) => b.text)
    .join(" ")

  return (
    <ToolCard title={t("title")} testId="screenshot-result-card">
      <div className="flex items-start gap-2">
        <CameraIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="max-w-md">
            <PluginImage src={src} alt={t("alt")} />
          </div>
          {note && (
            <p className="text-[11px] text-muted-foreground" data-testid="screenshot-result-note">
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
