"use client"

// gap3 — spec-driven renderer for a third-party MCP tool result that carries
// structured content blocks (preserved by `lib/claude/adapter.ts` onto the
// part as `mcpContent`). Walks the blocks and renders each by kind — text as
// markdown, images/audio inline, embedded resources as text/code or a
// download — instead of dumping a stringified base64 wall. Falls back to the
// generic ToolBody when no blocks survived (handled by the caller).

import { memo } from "react"
import { useTranslations } from "next-intl"
import type { ToolUIPart } from "ai"
import type { McpResultBlock } from "@/lib/claude/parts-extensions"
import { ToolInput } from "@/components/ai-elements/tool"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { ImageBlock } from "@/components/chat/renderers/image-block"
import { AudioBlock } from "@/components/chat/renderers/audio-block"
import { languageFromPath } from "./common"

/** Build a usable `src` (data URL) from an image/audio block in either wire shape. */
function blockMediaSrc(block: McpResultBlock, fallbackMime: string): string | null {
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

function ResourceBlock({ block }: { block: Extract<McpResultBlock, { type: "resource" }> }) {
  const t = useTranslations("chat.mcpContent")
  const res = block.resource ?? {}
  const uri = typeof res.uri === "string" ? res.uri : undefined
  if (typeof res.text === "string") {
    return (
      <div className="space-y-1" data-testid="mcp-block-resource">
        {uri ? <p className="truncate text-[11px] text-muted-foreground">{uri}</p> : null}
        <CodeBlock
          code={res.text}
          language={languageFromPath(uri ?? res.mimeType)}
          showLineNumbers={false}
        />
      </div>
    )
  }
  if (typeof res.blob === "string") {
    const mime = typeof res.mimeType === "string" ? res.mimeType : "application/octet-stream"
    const href = res.blob.startsWith("data:") ? res.blob : `data:${mime};base64,${res.blob}`
    return (
      <a
        href={href}
        download={uri ?? "resource"}
        className="inline-flex items-center gap-1.5 rounded border px-2 py-1 text-sm hover:bg-muted"
        data-testid="mcp-block-resource"
      >
        <span aria-hidden>📎</span>
        {t("embeddedResource", { uri: uri ?? "resource" })}
      </a>
    )
  }
  return (
    <pre
      className="overflow-x-auto rounded bg-muted/40 p-2 text-[11px]"
      data-testid="mcp-block-resource"
    >
      {JSON.stringify(block, null, 2)}
    </pre>
  )
}

function ContentBlock({ block, index }: { block: McpResultBlock; index: number }) {
  switch (block.type) {
    case "text":
      return (
        <div data-testid="mcp-block-text">
          <MarkdownRenderer content={(block as { text?: string }).text ?? ""} />
        </div>
      )
    case "image": {
      const src = blockMediaSrc(block, "image/png")
      if (!src) return null
      return <ImageBlock key={index} src={src} />
    }
    case "audio": {
      const src = blockMediaSrc(block, "audio/mpeg")
      if (!src) return null
      return <AudioBlock key={index} src={src} />
    }
    case "resource":
      return <ResourceBlock block={block as Extract<McpResultBlock, { type: "resource" }>} />
    default:
      return (
        <pre
          className="overflow-x-auto rounded bg-muted/40 p-2 text-[11px]"
          data-testid="mcp-block-unknown"
        >
          {JSON.stringify(block, null, 2)}
        </pre>
      )
  }
}

export const McpContentBlocksCard = memo(function McpContentBlocksCard({
  part,
  blocks,
}: {
  part: ToolUIPart
  blocks: McpResultBlock[]
}) {
  return (
    <div className="space-y-3" data-testid="mcp-content-blocks">
      {part.input !== undefined && part.input !== null && <ToolInput input={part.input} />}
      {blocks.map((block, i) => (
        <ContentBlock key={i} block={block} index={i} />
      ))}
    </div>
  )
})

export default McpContentBlocksCard
