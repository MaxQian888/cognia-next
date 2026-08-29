"use client"

/**
 * CanvasInlinePart — embeds a low-height read-only preview of a Canvas
 * document directly in the chat thread. Here we surface just enough context
 * for the user to recognise the document, plus an "Open in Canvas" jump.
 *
 * The jump is a store write, not a link. There is no `/canvas/<id>` route and
 * never was: the app is a static export with no dynamic segments, so the
 * anchor this used to render 404'd on every click. `revealCanvasDocument`
 * activates the document and switches the shell to the Canvas guild, which is
 * what actually mounts `CanvasShell` (`desktop-chat-workspace.tsx`).
 *
 * Why read-only?
 * The Canvas editor is heavy (Monaco + CRDT collab + plugins). Mounting it
 * inline inside every assistant turn would burn the chat surface. We render
 * a compact preview (code block for `type: "code"`, markdown for `type:
 * "text"`) and provide a single click to jump into the full editor.
 */

import { memo, useCallback, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  Artifact as ArtifactShell,
  ArtifactActions,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from "@/components/ai-elements/artifact"
import { Button } from "@/components/ui/button"
import { ChevronDownIcon, ChevronUpIcon, ExternalLinkIcon, FileWarningIcon } from "lucide-react"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { revealCanvasDocument } from "@/lib/artifacts/reveal"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import type { CanvasInlinePart as CanvasInlinePartType } from "@/lib/claude/parts-extensions"
import { cn } from "@/lib/utils"

interface CanvasInlinePartProps {
  part: CanvasInlinePartType
  className?: string
}

export const CanvasInlinePart = memo(function CanvasInlinePart({
  part,
  className,
}: CanvasInlinePartProps) {
  const t = useTranslations("chat.canvasInline")
  const tArtifact = useTranslations("chat.artifactPart")
  const canvas = useArtifactStore((s) => s.canvasDocuments[part.canvasId])
  const [open, setOpen] = useState(true)
  const router = useRouter()
  const pathname = usePathname()

  // Same shape as `use-shell-nav.ts:goHome` — the Canvas guild only renders on
  // `/`, so a card opened from `/inbox/c` has to route there first.
  const handleOpenInCanvas = useCallback(() => {
    if (!revealCanvasDocument(part.canvasId)) return
    if (pathname !== "/") router.push("/")
  }, [part.canvasId, pathname, router])

  if (!canvas) {
    return (
      <div
        data-testid="canvas-inline-part-missing"
        className={cn(
          "my-2 flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-muted-foreground text-xs",
          className
        )}
        role="status"
      >
        <FileWarningIcon className="size-3.5" aria-hidden="true" />
        <span>
          {part.title}
          <span className="ml-2 opacity-70">{tArtifact("cleared")}</span>
        </span>
      </div>
    )
  }

  const maxHeight = part.maxHeight ?? 320

  return (
    <ArtifactShell
      data-testid="canvas-inline-part"
      data-canvas-id={canvas.id}
      data-readonly={part.readonly === true ? "true" : "false"}
      className={cn("not-prose my-2", className)}
    >
      <ArtifactHeader>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <ArtifactTitle className="truncate">{canvas.title || part.title}</ArtifactTitle>
          <ArtifactDescription className="truncate text-xs">
            {canvas.language
              ? t("subtitleWithLanguage", { type: canvas.type, language: canvas.language })
              : t("subtitle", { type: canvas.type })}
          </ArtifactDescription>
        </div>
        <ArtifactActions>
          <Button
            variant="ghost"
            size="sm"
            className="size-8 p-0 text-muted-foreground hover:text-foreground"
            onClick={handleOpenInCanvas}
            data-testid="canvas-inline-part-open"
            aria-label={t("openInCanvas")}
            title={t("openInCanvas")}
            type="button"
          >
            <ExternalLinkIcon className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="size-8 p-0 text-muted-foreground hover:text-foreground"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? t("collapsePreview") : t("expandPreview")}
            data-testid="canvas-inline-part-toggle"
            type="button"
          >
            {open ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
          </Button>
        </ArtifactActions>
      </ArtifactHeader>
      {open && (
        <ArtifactContent className="p-0">
          <div
            className="overflow-auto"
            style={{ maxHeight: `${maxHeight}px` }}
            data-testid="canvas-inline-part-body"
          >
            {canvas.type === "code" ? (
              <CodeBlock
                code={canvas.content}
                language={canvas.language || "text"}
                showLineNumbers
              />
            ) : (
              <div className="px-3 py-2">
                <MarkdownRenderer content={canvas.content} />
              </div>
            )}
          </div>
        </ArtifactContent>
      )}
    </ArtifactShell>
  )
})

export default CanvasInlinePart
