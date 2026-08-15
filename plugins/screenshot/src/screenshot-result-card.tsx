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

import type { ToolResultRendererProps } from "@/lib/plugin/api/tool-result-renderers"
import {
  McpCardShell,
  blockMediaSrc,
  parseOutputJson,
} from "@/components/chat/message-parts/mcp-renderers/common"
import type { McpResultBlock } from "@/lib/claude/parts-extensions"
import { ImageBlock } from "@/components/chat/renderers/image-block"

interface ContentBlockLike {
  type?: string
  text?: string
}

/** Pull the content blocks off either wire shape (`mcpContent` or `output.content`). */
export function screenshotBlocks(part: unknown): McpResultBlock[] {
  const p = part as { mcpContent?: unknown; output?: unknown }
  if (Array.isArray(p.mcpContent)) return p.mcpContent as McpResultBlock[]
  const parsed = parseOutputJson(p.output) as { content?: unknown } | null
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
    <McpCardShell title={t("title")} testId="screenshot-result-card">
      <div className="flex items-start gap-2">
        <CameraIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="max-w-md">
            <ImageBlock src={src} alt={t("alt")} />
          </div>
          {note && (
            <p className="text-[11px] text-muted-foreground" data-testid="screenshot-result-note">
              {note}
            </p>
          )}
        </div>
      </div>
    </McpCardShell>
  )
}
