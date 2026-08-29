"use client"

/**
 * ArtifactPart — inline collapsible panel rendering an artifact directly in
 * the chat thread. Reads the live artifact from `useArtifactStore` so updates
 * to the artifact (e.g. version bumps) reflect without a part re-emit. Falls
 * back to a "cleared" placeholder when the store no longer has the row.
 */

import { memo, useCallback, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Artifact as ArtifactShell,
  ArtifactActions,
  ArtifactAction,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from "@/components/ai-elements/artifact"
import { ArtifactPreview } from "@/components/artifacts/artifact-preview"
import { AnimatedActionIcon, CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import { DownloadIcon as AnimatedDownloadIcon } from "@/components/ui/download"
import { Button } from "@/components/ui/button"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { revealArtifactInWorkspace } from "@/lib/artifacts/reveal"
import { exportArtifact } from "@/lib/artifacts/export"
import { getPreferredArtifactExportFormat } from "@/components/artifacts/runtime-adapters"
import { ARTIFACT_AUTO_PREVIEW_MAX_CHARS } from "@/lib/artifacts/constants"
import { useNearViewport } from "@/hooks/chat/use-near-viewport"
import { toast } from "sonner"
import { useCopy } from "@/hooks/ui/use-copy"
import type { ArtifactPart as ArtifactPartType } from "@/lib/claude/parts-extensions"
import { ChevronDownIcon, ChevronUpIcon, ExternalLinkIcon, FileWarningIcon } from "lucide-react"
import { cn } from "@/lib/utils"

interface ArtifactPartProps {
  part: ArtifactPartType
  className?: string
}

export const ArtifactPart = memo(function ArtifactPart({ part, className }: ArtifactPartProps) {
  const t = useTranslations("chat.artifactPart")
  const artifact = useArtifactStore((s) => s.artifacts[part.artifactId])
  const [open, setOpen] = useState(part.defaultOpen !== false)
  const [forcePreview, setForcePreview] = useState(false)
  const { copy, copied } = useCopy()

  // A transcript full of artifact cards mounted one live iframe EACH at first
  // paint — every one of them sanitising, writing a document and, for a React
  // artifact, loading a whole runtime. The same latch `mermaid-block.tsx` uses:
  // nothing renders until the card is about a screen away.
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const near = useNearViewport(bodyRef, { disabled: forcePreview })

  // Two things stay behind an explicit click rather than a scroll:
  // a large document, and ANY React artifact — the latter costs a runtime load
  // regardless of how short its source is.
  const oversized = (artifact?.content.length ?? 0) > ARTIFACT_AUTO_PREVIEW_MAX_CHARS
  const manualOnly = artifact?.type === "react" || oversized
  const showPreview = forcePreview || (near && !manualOnly)

  const handleOpenInCanvas = useCallback(() => {
    revealArtifactInWorkspace(part.artifactId)
  }, [part.artifactId])

  // Goes through the shared exporter, which is what the dock's own download
  // button uses. The hand-rolled version this replaces ignored the artifact's
  // export contract entirely: it forced `text/plain` and built the extension
  // from `artifact.type`, so a chart downloaded as `chart.chart`. It also used
  // an `<a download>` anchor, which silently no-ops inside a mobile WebView.
  const handleDownload = useCallback(async () => {
    if (!artifact) return
    try {
      const outcome = await exportArtifact(artifact, getPreferredArtifactExportFormat(artifact))
      if (outcome.kind === "error") throw new Error(outcome.message)
    } catch (error) {
      toast.error(t("downloadFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [artifact, t])

  const handleCopy = useCallback(() => {
    if (!artifact) return
    void copy(artifact.content)
  }, [artifact, copy])

  if (!artifact) {
    return (
      <div
        data-testid="artifact-part-missing"
        className={cn(
          "my-2 flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-muted-foreground text-xs",
          className
        )}
        role="status"
      >
        <FileWarningIcon className="size-3.5" aria-hidden="true" />
        <span>
          {part.title}
          <span className="ml-2 opacity-70">{t("cleared")}</span>
        </span>
      </div>
    )
  }

  return (
    <ArtifactShell
      data-testid="artifact-part"
      data-artifact-id={part.artifactId}
      className={cn("not-prose my-2", className)}
    >
      <ArtifactHeader>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <ArtifactTitle className="truncate">{artifact.title || part.title}</ArtifactTitle>
          <ArtifactDescription className="truncate text-xs">{part.kind}</ArtifactDescription>
        </div>
        <ArtifactActions>
          <ArtifactAction
            tooltip={copied ? t("copied") : t("copy")}
            label={t("copyAria")}
            onClick={handleCopy}
            data-testid="artifact-part-copy"
          >
            <CopyFeedbackIcon copied={copied} size={16} />
          </ArtifactAction>
          <ArtifactAction
            tooltip={t("download")}
            label={t("downloadAria")}
            onClick={() => void handleDownload()}
            data-testid="artifact-part-download"
          >
            <AnimatedActionIcon icon={AnimatedDownloadIcon} size={16} />
          </ArtifactAction>
          <ArtifactAction
            tooltip={t("openInCanvas")}
            label={t("openInCanvasAria")}
            icon={ExternalLinkIcon}
            onClick={handleOpenInCanvas}
            data-testid="artifact-part-open-canvas"
          />
          <Button
            variant="ghost"
            size="sm"
            className="size-8 p-0 text-muted-foreground hover:text-foreground"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? t("collapse") : t("expand")}
            data-testid="artifact-part-toggle"
            type="button"
          >
            {open ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
          </Button>
        </ArtifactActions>
      </ArtifactHeader>
      {open && (
        <ArtifactContent className="max-h-72 p-0">
          <div className="h-72 w-full" ref={bodyRef} data-testid="artifact-part-body">
            {showPreview ? (
              <ArtifactPreview artifact={artifact} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                <p className="text-muted-foreground text-xs">
                  {artifact.type === "react"
                    ? t("previewReactManual")
                    : oversized
                      ? t("previewDeferred")
                      : ""}
                </p>
                {manualOnly ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setForcePreview(true)}
                    data-testid="artifact-part-preview-anyway"
                    type="button"
                  >
                    {t("previewAnyway")}
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        </ArtifactContent>
      )}
    </ArtifactShell>
  )
})

export default ArtifactPart
