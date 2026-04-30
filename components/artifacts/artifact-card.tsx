"use client"

/**
 * ArtifactCard - Card component to display artifact reference in messages.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { ExternalLink, Eye, Copy, Ruler, BarChart3, Table } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { revealArtifactInWorkspace } from "@/lib/artifacts"
import type { Artifact } from "@/types"
import { ARTIFACT_COLORS, ARTIFACT_I18N_TYPE_KEYS } from "@/lib/artifacts"
import { getArtifactTypeIcon } from "./artifact-icons"

interface ArtifactCardProps {
  artifact: Artifact
  className?: string
  compact?: boolean
  showPreview?: boolean
}

const typeLabelKeys = ARTIFACT_I18N_TYPE_KEYS
const typeColors = ARTIFACT_COLORS

export function ArtifactCard({
  artifact,
  className,
  compact = false,
  showPreview = false,
}: ArtifactCardProps) {
  const t = useTranslations("artifacts")
  const duplicateArtifact = useArtifactStore((state) => state.duplicateArtifact)

  const handleOpen = () => {
    revealArtifactInWorkspace(artifact.id)
  }

  const handleDuplicate = (e: React.MouseEvent) => {
    e.stopPropagation()
    const dup = duplicateArtifact(artifact.id)
    if (dup) {
      revealArtifactInWorkspace(dup.id)
    }
  }

  const previewSnippet =
    artifact.content.slice(0, 100).trim() + (artifact.content.length > 100 ? "..." : "")

  if (compact) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn("gap-2 h-7 text-xs", typeColors[artifact.type], className)}
              onClick={handleOpen}
            >
              {getArtifactTypeIcon(artifact.type)}
              <span className="max-w-[120px] truncate">{artifact.title}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{artifact.title}</p>
            <p className="text-xs text-muted-foreground">
              {t(typeLabelKeys[artifact.type])} · v{artifact.version}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <Card
      className={cn(
        "overflow-hidden cursor-pointer transition-colors hover:bg-muted/50",
        className
      )}
      onClick={handleOpen}
    >
      <CardContent className="p-3">
        <div className="flex items-start gap-3">
          <div className={cn("shrink-0 p-2 rounded-lg", typeColors[artifact.type])}>
            {getArtifactTypeIcon(artifact.type)}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h4 className="font-medium text-sm truncate">{artifact.title}</h4>
              <Badge variant="secondary" className="shrink-0 text-xs">
                {t(typeLabelKeys[artifact.type])}
              </Badge>
            </div>

            {showPreview && (
              <pre className="text-xs text-muted-foreground font-mono bg-muted/50 rounded p-2 overflow-hidden">
                {previewSnippet}
              </pre>
            )}

            <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
              <span>v{artifact.version}</span>
              {artifact.language && (
                <>
                  <span>·</span>
                  <span>{artifact.language}</span>
                </>
              )}
              {artifact.metadata?.runnable && (
                <>
                  <span>·</span>
                  <span>{t("runnable")}</span>
                </>
              )}
              {artifact.metadata?.wordCount != null && (
                <>
                  <span>·</span>
                  <span>
                    {artifact.metadata.wordCount} {t("words")}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="shrink-0 flex flex-col gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={(e) => {
                e.stopPropagation()
                handleOpen()
              }}
            >
              <Eye className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleDuplicate}
              title={t("duplicate")}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function ArtifactInlineRef({
  artifact,
  className,
}: {
  artifact: Artifact
  className?: string
}) {
  return (
    <button
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs",
        "bg-primary/10 text-primary hover:bg-primary/20 transition-colors",
        className
      )}
      onClick={() => {
        revealArtifactInWorkspace(artifact.id)
      }}
    >
      {getArtifactTypeIcon(artifact.type)}
      <span className="font-medium">{artifact.title}</span>
      <ExternalLink className="h-3 w-3 opacity-50" />
    </button>
  )
}

export function MessageArtifacts({
  messageId,
  className,
  compact = true,
}: {
  messageId: string
  className?: string
  compact?: boolean
}) {
  const artifacts = useArtifactStore((state) => state.artifacts)
  const messageArtifacts = useMemo(
    () => Object.values(artifacts).filter((artifact) => artifact.messageId === messageId),
    [artifacts, messageId]
  )

  if (messageArtifacts.length === 0) {
    return null
  }

  if (compact) {
    return (
      <div className={cn("flex flex-wrap gap-1 mt-2", className)}>
        {messageArtifacts.map((artifact) => (
          <ArtifactInlineRef key={artifact.id} artifact={artifact} />
        ))}
      </div>
    )
  }

  return (
    <div className={cn("space-y-2 mt-3", className)}>
      {messageArtifacts.map((artifact) => (
        <ArtifactCard key={artifact.id} artifact={artifact} showPreview />
      ))}
    </div>
  )
}

export function MessageAnalysisResults({
  messageId,
  className,
}: {
  messageId: string
  className?: string
}) {
  const getMessageAnalysis = useArtifactStore((state) => state.getMessageAnalysis)
  const openPanel = useArtifactStore((state) => state.openPanel)

  const analysisResults = getMessageAnalysis(messageId)

  if (analysisResults.length === 0) {
    return null
  }

  return (
    <div className={cn("flex flex-wrap gap-1.5 mt-2", className)}>
      {analysisResults.map((result) => (
        <Button
          key={result.id}
          variant="outline"
          size="sm"
          className="gap-1.5 h-7 text-xs"
          onClick={() => {
            openPanel("analysis")
          }}
        >
          {result.type === "math" && <Ruler className="h-3.5 w-3.5" />}
          {result.type === "chart" && <BarChart3 className="h-3.5 w-3.5" />}
          {result.type === "data" && <Table className="h-3.5 w-3.5" />}
          <span className="max-w-[100px] truncate">{result.output?.summary || result.type}</span>
        </Button>
      ))}
    </div>
  )
}
