"use client"

/**
 * Canvas Preview Pane — live preview for the active Canvas document.
 *
 * Reuses the Artifacts preview stack rather than reimplementing rendering: a
 * `CanvasDocument` is projected onto a synthetic `Artifact`
 * (`canvasDocumentToArtifact`) and handed to `ArtifactPreview`, which already
 * renders Markdown / HTML / React / SVG / Mermaid / chart / math in a sandboxed,
 * DOMPurify-hardened surface. Non-previewable code documents show a hint.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Eye } from "lucide-react"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { ArtifactPreview } from "@/components/artifacts/artifact-preview"
import { canvasDocumentToArtifact } from "@/lib/canvas/artifact-projection"

interface CanvasPreviewPaneProps {
  documentId: string
  className?: string
}

function PreviewEmpty({ message, className }: { message: string; className?: string }) {
  return (
    <div
      data-testid="canvas-preview-empty"
      className={cn("flex h-full min-h-0 items-center justify-center bg-muted/10", className)}
    >
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Eye />
          </EmptyMedia>
          <EmptyDescription className="text-xs">{message}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  )
}

export function CanvasPreviewPane({ documentId, className }: CanvasPreviewPaneProps) {
  const t = useTranslations("canvas.preview")
  const doc = useArtifactStore((s) => s.canvasDocuments[documentId])
  // Recomputes whenever the document object identity changes (every content
  // edit replaces it in the store), so the preview tracks the buffer live.
  const artifact = useMemo(() => (doc ? canvasDocumentToArtifact(doc) : null), [doc])

  if (!doc) {
    return <PreviewEmpty message={t("empty")} className={className} />
  }
  if (!artifact) {
    return (
      <PreviewEmpty message={t("unsupported", { language: doc.language })} className={className} />
    )
  }
  if (doc.content.trim().length === 0) {
    return <PreviewEmpty message={t("empty")} className={className} />
  }

  return (
    <div
      data-testid="canvas-preview-pane"
      className={cn("h-full min-h-0 min-w-0 overflow-auto bg-background", className)}
    >
      <ArtifactPreview artifact={artifact} className="h-full" />
    </div>
  )
}
