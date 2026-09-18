"use client"

import { useMemo } from "react"
import { ImageIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import {
  blockMediaSrc,
  languageFromPath,
  PreviewClampNote,
  useClampedRows,
  useParsedOutput,
} from "./common"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { ImageBlock } from "@/components/chat/renderers/image-block"
import { hasMcpContent } from "@/lib/claude/parts-extensions"
import { basenameOf } from "@/lib/files/file-type-icon"
import { WorkbenchFileLink } from "./workbench-file-link"

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

/**
 * Body content for a `read` tool call — path link + content (code or image).
 * Rendered bare: the surrounding row (`FileToolPart` / `ToolCallRow`) owns the
 * chrome now, so this is just the payload view. Kept in `mcp-renderers/` next
 * to the other per-tool bodies; the `mcp-read-card` testid stays for
 * compatibility with existing tests and automation.
 */
export function ReadCard({ part, sessionId }: { part: ToolUIPart; sessionId?: string }) {
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
  // A large read clamps to the first TOOL_PREVIEW_MAX_LINES lines — Shiki only
  // highlights the preview, and Show-all hands the full payload to CodeBlock
  // whose own line cap still bounds the extreme case.
  const lines = useMemo(() => code.split("\n"), [code])
  const clamp = useClampedRows(lines)
  const previewCode = clamp.hidden > 0 ? clamp.visible.join("\n") : code
  if (!path) return null

  const hasImages = images.length > 0
  // The row above already states the full path, so the code payload's header
  // carries the file identity instead of repeating the path on its own line.
  // Image reads have no code header to host the link — they keep theirs.
  const headerTitle = (
    <span data-testid="mcp-read-path">
      <WorkbenchFileLink
        sessionId={sessionId}
        path={path}
        line={input.offset}
        data-testid="mcp-read-path-link"
      >
        {basenameOf(path)}
      </WorkbenchFileLink>
      {input.offset !== undefined && ` · offset ${input.offset}`}
      {input.limit !== undefined && ` · limit ${input.limit}`}
    </span>
  )

  return (
    <div className="min-w-0" data-testid="mcp-read-card">
      {/* No code header to host the identity for images, and nothing to host
          it in at all while the read is still running — both keep a path row. */}
      {(hasImages || !code) && (
        <p className="font-mono text-[11px] text-muted-foreground" data-testid="mcp-read-path">
          {hasImages && (
            <ImageIcon className="mr-1 inline-block size-3 -translate-y-px align-middle" />
          )}
          <WorkbenchFileLink
            sessionId={sessionId}
            path={path}
            line={input.offset}
            data-testid="mcp-read-path-link"
          >
            {path}
          </WorkbenchFileLink>
          {input.offset !== undefined && ` · offset ${input.offset}`}
          {input.limit !== undefined && ` · limit ${input.limit}`}
        </p>
      )}
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
          <div data-testid="mcp-read-code">
            <CodeBlock
              code={previewCode}
              language={languageFromPath(path)}
              filename={basenameOf(path)}
              headerTitle={headerTitle}
              showLineNumbers
              compact
            />
            {clamp.hidden > 0 && (
              <PreviewClampNote
                shown={clamp.shown}
                total={clamp.total}
                onExpand={clamp.reveal}
                testId="mcp-read-clamped"
              />
            )}
          </div>
        )
      )}
    </div>
  )
}
