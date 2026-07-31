"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { FileIcon, ImageIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { blockMediaSrc, McpCardShell, languageFromPath, useParsedOutput } from "./common"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { ImageBlock } from "@/components/chat/renderers/image-block"
import { hasMcpContent } from "@/lib/claude/parts-extensions"

interface ReadInput {
  path?: string
  file_path?: string
  offset?: number
  limit?: number
}

interface ReadOutput {
  content?: string
  lines?: string[]
  startLine?: number
}

export function ReadCard({ part }: { part: ToolUIPart }) {
  const t = useTranslations("chat.mcp.read")
  const input = (part.input ?? {}) as ReadInput
  const path = input.path ?? input.file_path
  const parsed = useParsedOutput<ReadOutput>(part.output)
  // Reading an image returns real image content blocks (sidecar `toolImage`,
  // or a native SDK image tool_result). `output` only holds the flattened
  // stand-in, so the blocks are the authoritative payload — render them and
  // skip the code block entirely.
  const images = useMemo(() => {
    if (!hasMcpContent(part)) return []
    return part.mcpContent
      .filter((block) => block.type === "image")
      .map((block) => blockMediaSrc(block, "image/png"))
      .filter((src): src is string => src !== null)
  }, [part])
  // Joining a multi-line `lines[]` payload back into a single string can be
  // expensive for large files; recompute only when the parsed/raw output moves.
  const code = useMemo(
    () =>
      parsed?.content ??
      (Array.isArray(parsed?.lines) ? parsed!.lines.join("\n") : undefined) ??
      (typeof part.output === "string" ? part.output : ""),
    [parsed, part.output]
  )
  if (!path) return null

  const hasImages = images.length > 0
  const Icon = hasImages ? ImageIcon : FileIcon

  return (
    <McpCardShell title={t("title")} badge={path} testId="mcp-read-card">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] text-muted-foreground" data-testid="mcp-read-path">
            {path}
            {input.offset !== undefined && ` · offset ${input.offset}`}
            {input.limit !== undefined && ` · limit ${input.limit}`}
          </p>
          {hasImages ? (
            <div data-testid="mcp-read-image">
              {images.map((src, i) => (
                // `alt` doubles as the lightbox caption (same convention as
                // ComputerUseCard) — the path is the only meaningful label.
                <ImageBlock key={i} src={src} alt={path} />
              ))}
            </div>
          ) : (
            code && (
              <div className="mt-1" data-testid="mcp-read-code">
                <CodeBlock code={code} language={languageFromPath(path)} showLineNumbers />
              </div>
            )
          )}
        </div>
      </div>
    </McpCardShell>
  )
}
