"use client"

/**
 * ArtifactPart — inline collapsible panel rendering an artifact directly in
 * the chat thread. Reads the live artifact from `useArtifactStore` so updates
 * to the artifact (e.g. version bumps) reflect without a part re-emit. Falls
 * back to a "cleared" placeholder when the store no longer has the row.
 */

import { memo, useCallback, useState } from "react"
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
  const { copy, copied } = useCopy()

  const handleOpenInCanvas = useCallback(() => {
    revealArtifactInWorkspace(part.artifactId)
  }, [part.artifactId])

  const handleDownload = useCallback(() => {
    if (!artifact) return
    const blob = new Blob([artifact.content], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${artifact.title || "artifact"}.${artifact.language || artifact.type || "txt"}`
    a.click()
    URL.revokeObjectURL(url)
  }, [artifact])

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
            onClick={handleDownload}
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
          <div className="h-72 w-full">
            <ArtifactPreview artifact={artifact} />
          </div>
        </ArtifactContent>
      )}
    </ArtifactShell>
  )
})

export default ArtifactPart
