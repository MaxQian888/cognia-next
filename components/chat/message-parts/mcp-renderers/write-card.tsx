"use client"

// Structured card for the core `write` tool (and SDK `Write`): target path +
// a syntax-highlighted preview of the content being written.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { FilePlus2Icon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { McpCardShell, languageFromPath } from "./common"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { WorkbenchReviewButton } from "./workbench-review-button"

const PREVIEW_CHAR_CAP = 4_000

interface WriteInput {
  file_path?: string
  path?: string
  content?: string
}

export function WriteCard({ part, sessionId }: { part: ToolUIPart; sessionId?: string }) {
  const t = useTranslations("chat.mcp.write")
  const input = (part.input ?? {}) as WriteInput
  const path = input.file_path ?? input.path
  const content = typeof input.content === "string" ? input.content : ""
  // Slicing the preview and counting lines both scan the full file content;
  // recompute only when the written content changes, not on every render.
  const { clipped, preview, lineCount } = useMemo(() => {
    const isClipped = content.length > PREVIEW_CHAR_CAP
    return {
      clipped: isClipped,
      preview: isClipped ? content.slice(0, PREVIEW_CHAR_CAP) : content,
      lineCount: content.split("\n").length,
    }
  }, [content])
  if (!path || typeof input.content !== "string") return null

  return (
    <McpCardShell
      title={t("title")}
      badge={path}
      testId="mcp-write-card"
      action={<WorkbenchReviewButton sessionId={sessionId} absolutePath={path} />}
    >
      <div className="flex items-start gap-2">
        <FilePlus2Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] text-muted-foreground" data-testid="mcp-write-path">
            {path} · {t("lineCount", { count: lineCount })}
          </p>
          <div className="mt-1" data-testid="mcp-write-code">
            <CodeBlock code={preview} language={languageFromPath(path)} showLineNumbers />
          </div>
          {clipped && <p className="mt-1 text-[11px] text-muted-foreground">{t("truncated")}</p>}
        </div>
      </div>
    </McpCardShell>
  )
}
