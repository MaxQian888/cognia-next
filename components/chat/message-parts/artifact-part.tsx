"use client"

/**
 * ArtifactPart — inline collapsible panel rendering an artifact directly in
 * the chat thread. Reads the live artifact from `useArtifactStore` so updates
 * to the artifact (e.g. version bumps) reflect without a part re-emit. Falls
 * back to a "cleared" placeholder when the store no longer has the row.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Artifact as ArtifactShell,
  ArtifactActions,
  ArtifactAction,
  ArtifactContent,
  ArtifactHeader,
  ArtifactTitle,
} from "@/components/ai-elements/artifact"
import { ArtifactPreview } from "@/components/artifacts/artifact-preview"
import { getArtifactTypeIcon } from "@/components/artifacts/artifact-icons"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { AnimatedActionIcon, CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import { DownloadIcon as AnimatedDownloadIcon } from "@/components/ui/download"
import { Button } from "@/components/ui/button"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { revealArtifactInWorkspace } from "@/lib/artifacts/reveal"
import { exportArtifact } from "@/lib/artifacts/export"
import {
  getArtifactRuntimeAdapter,
  getPreferredArtifactExportFormat,
} from "@/components/artifacts/runtime-adapters"
import {
  ARTIFACT_AUTO_PREVIEW_MAX_CHARS,
  ARTIFACT_COLORS,
  ARTIFACT_I18N_TYPE_KEYS,
  getLanguageDisplayName,
  getShikiLanguage,
} from "@/lib/artifacts/constants"
import { useNearViewport } from "@/hooks/chat/use-near-viewport"
import { toast } from "sonner"
import { useCopy } from "@/hooks/ui/use-copy"
import type { ArtifactPart as ArtifactPartType } from "@/lib/claude/parts-extensions"
import type { Artifact } from "@/types"
import {
  ChevronDownIcon,
  CodeXmlIcon,
  EyeIcon,
  ExternalLinkIcon,
  FileWarningIcon,
  Maximize2Icon,
  Minimize2Icon,
} from "lucide-react"
import { cn } from "@/lib/utils"

interface ArtifactPartProps {
  part: ArtifactPartType
  className?: string
}

type BodyView = "preview" | "source"

/**
 * Types whose content is a data model rather than something a reader scans
 * line by line, so a line count says nothing about them.
 */
const NO_LINE_COUNT_TYPES = new Set<Artifact["type"]>(["chart", "jupyter"])

/**
 * Whether the body can size itself to its content. Renderer-transport previews
 * draw as live React in this tree and have a natural height; an iframe (html,
 * svg, react) or a notebook has none, so it keeps a fixed frame. A plugin-owned
 * artifact mounts the plugin's own renderer, whose height is equally unknown.
 */
function hasNaturalHeight(artifact: Artifact, view: BodyView): boolean {
  if (view === "source") return true
  if (artifact.metadata?.plugin) return false
  return getArtifactRuntimeAdapter(artifact.type).transport === "renderer"
}

/**
 * Tracks whether a height-capped scroller is clipping its content, so the card
 * can offer "Show more" only when there IS more. jsdom lays nothing out, so the
 * answer there is always `false` — honest for a layout that never happened.
 */
function useClipped(ref: React.RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [clipped, setClipped] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (!enabled || !node) return
    const measure = () => setClipped(node.scrollHeight - node.clientHeight > 4)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    const content = node.firstElementChild
    if (content) observer.observe(content)
    return () => observer.disconnect()
  }, [ref, enabled])
  return enabled && clipped
}

export const ArtifactPart = memo(function ArtifactPart({ part, className }: ArtifactPartProps) {
  const t = useTranslations("chat.artifactPart")
  const tArtifacts = useTranslations("artifacts")
  const artifact = useArtifactStore((s) => s.artifacts[part.artifactId])
  const [open, setOpen] = useState(part.defaultOpen !== false)
  const [forcePreview, setForcePreview] = useState(false)
  const [view, setView] = useState<BodyView>("preview")
  const [expanded, setExpanded] = useState(false)
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

  const naturalHeight = artifact ? hasNaturalHeight(artifact, view) : false
  const clipped = useClipped(bodyRef, open && naturalHeight && !expanded)

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
          "not-prose my-2 flex items-center gap-2 rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-muted-foreground text-xs",
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

  const typeKey = ARTIFACT_I18N_TYPE_KEYS[artifact.type]
  const typeLabel = typeKey ? tArtifacts(typeKey) : part.kind
  // Code is the one type whose language is news; every other type implies it.
  const languageLabel =
    artifact.type === "code" && artifact.language ? getLanguageDisplayName(artifact.language) : null
  const lineCount = NO_LINE_COUNT_TYPES.has(artifact.type)
    ? null
    : artifact.content.split("\n").length
  const meta = [
    typeLabel,
    languageLabel,
    lineCount !== null ? t("lineCount", { count: lineCount }) : null,
    artifact.version > 1 ? t("version", { version: artifact.version }) : null,
  ].filter((entry): entry is string => Boolean(entry))

  // For code the preview IS the source, so the switch would be a no-op.
  const canViewSource = artifact.type !== "code"

  const renderBody = () => {
    if (view === "source") {
      return (
        <CodeBlock
          code={artifact.content}
          language={getShikiLanguage(artifact.language)}
          showLineNumbers
          compact
          className="my-0 rounded-none border-0"
        />
      )
    }
    if (showPreview) {
      return <ArtifactPreview artifact={artifact} density="compact" />
    }
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 px-4 text-center",
          naturalHeight ? "min-h-32 py-6" : "h-full"
        )}
      >
        {manualOnly ? (
          <>
            <p className="text-muted-foreground text-xs">
              {artifact.type === "react" ? t("previewReactManual") : t("previewDeferred")}
            </p>
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
          </>
        ) : null}
      </div>
    )
  }

  return (
    <ArtifactShell
      data-testid="artifact-part"
      data-artifact-id={part.artifactId}
      data-view={view}
      className={cn(
        "not-prose my-3 rounded-xl border-border/80 shadow-xs transition-shadow hover:shadow-sm",
        className
      )}
    >
      <ArtifactHeader
        className={cn("gap-3 bg-muted/30 px-3 py-2", !open && "border-b-0")}
        data-testid="artifact-part-header"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span
            aria-hidden="true"
            data-testid="artifact-part-type-icon"
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg",
              ARTIFACT_COLORS[artifact.type]
            )}
          >
            {getArtifactTypeIcon(artifact.type, "size-4")}
          </span>
          <div className="min-w-0 flex-1">
            <ArtifactTitle className="truncate leading-5" title={artifact.title || part.title}>
              {artifact.title || part.title}
            </ArtifactTitle>
            <p
              data-testid="artifact-part-meta"
              className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground text-xs leading-4"
            >
              {meta.map((entry, index) => (
                <span key={`${index}-${entry}`} className="flex shrink-0 items-center gap-1.5">
                  {index > 0 ? (
                    <span aria-hidden="true" className="text-muted-foreground/50">
                      ·
                    </span>
                  ) : null}
                  {entry}
                </span>
              ))}
            </p>
          </div>
        </div>
        <ArtifactActions className="shrink-0 gap-0.5">
          {open && canViewSource ? (
            <ArtifactAction
              tooltip={view === "source" ? t("viewPreview") : t("viewSource")}
              label={view === "source" ? t("viewPreview") : t("viewSource")}
              icon={view === "source" ? EyeIcon : CodeXmlIcon}
              onClick={() => setView((v) => (v === "source" ? "preview" : "source"))}
              aria-pressed={view === "source"}
              className="size-7 p-0 [&_svg]:size-3.5"
              data-testid="artifact-part-view-toggle"
            />
          ) : null}
          <ArtifactAction
            tooltip={copied ? t("copied") : t("copy")}
            label={t("copyAria")}
            onClick={handleCopy}
            className="size-7 p-0"
            data-testid="artifact-part-copy"
          >
            <CopyFeedbackIcon copied={copied} size={14} />
          </ArtifactAction>
          <ArtifactAction
            tooltip={t("download")}
            label={t("downloadAria")}
            onClick={() => void handleDownload()}
            className="size-7 p-0"
            data-testid="artifact-part-download"
          >
            <AnimatedActionIcon icon={AnimatedDownloadIcon} size={14} />
          </ArtifactAction>
          {open ? (
            <ArtifactAction
              tooltip={expanded ? t("shrink") : t("enlarge")}
              label={expanded ? t("shrink") : t("enlarge")}
              icon={expanded ? Minimize2Icon : Maximize2Icon}
              onClick={() => setExpanded((v) => !v)}
              aria-pressed={expanded}
              className="size-7 p-0 [&_svg]:size-3.5"
              data-testid="artifact-part-enlarge"
            />
          ) : null}
          <ArtifactAction
            tooltip={t("openInCanvas")}
            label={t("openInCanvasAria")}
            icon={ExternalLinkIcon}
            onClick={handleOpenInCanvas}
            className="size-7 p-0 [&_svg]:size-3.5"
            data-testid="artifact-part-open-canvas"
          />
          <Button
            variant="ghost"
            size="sm"
            className="size-7 p-0 text-muted-foreground hover:text-foreground"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? t("collapse") : t("expand")}
            data-testid="artifact-part-toggle"
            type="button"
          >
            <ChevronDownIcon
              className={cn("size-4 transition-transform duration-200", open && "rotate-180")}
            />
          </Button>
        </ArtifactActions>
      </ArtifactHeader>
      {open && (
        <ArtifactContent className="relative flex-none overflow-visible p-0">
          <div
            ref={bodyRef}
            data-testid="artifact-part-body"
            data-expanded={expanded}
            className={cn(
              "w-full",
              naturalHeight
                ? cn("overflow-y-auto", expanded ? "max-h-[70vh]" : "max-h-80")
                : expanded
                  ? "h-[70vh]"
                  : "h-72"
            )}
          >
            {renderBody()}
          </div>
          {clipped ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-16 items-end justify-center bg-gradient-to-t from-background via-background/80 to-transparent pb-2">
              <Button
                variant="outline"
                size="sm"
                className="pointer-events-auto h-7 gap-1 rounded-pill bg-background px-3 text-xs shadow-xs"
                onClick={() => setExpanded(true)}
                data-testid="artifact-part-show-more"
                type="button"
              >
                {t("showMore")}
                <ChevronDownIcon className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          ) : null}
        </ArtifactContent>
      )}
    </ArtifactShell>
  )
})

export default ArtifactPart
