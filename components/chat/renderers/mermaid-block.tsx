"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import { AlertCircle, Maximize2, Code2, RefreshCw } from "lucide-react"
import { AnimatedActionIcon, CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import { DownloadIcon as AnimatedDownloadIcon } from "@/components/ui/download"
import { PlayIcon as AnimatedPlayIcon } from "@/components/ui/play"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { useCopy } from "@/hooks/ui/use-copy"
import { useNearViewport } from "@/hooks/chat/use-near-viewport"
import { downloadBlob } from "@/lib/files/download"
import { loggers } from "@cognia/logging"
import {
  getCachedMermaid,
  readMermaidTheme,
  renderMermaidCached,
  subscribeMermaidTheme,
} from "@cognia/mermaid"

interface MermaidBlockProps {
  content: string
  className?: string
}

/**
 * Source length past which the diagram is not rendered until asked for.
 *
 * Mermaid layout is superlinear in node count: a few hundred nodes is seconds
 * of blocked main thread and megabytes of SVG. Past this point the block shows
 * the source with a render button instead of freezing the transcript on the
 * way past. Roughly a 200-node flowchart.
 */
export const MERMAID_AUTO_RENDER_MAX_CHARS = 8_000

/** Synchronous cache lookup used to seed initial state (no Skeleton flash). */
function seedMermaidSvg(content: string): string {
  if (typeof document === "undefined") return ""
  return getCachedMermaid(readMermaidTheme(), content.trim()) ?? ""
}

export function MermaidBlock({ content, className }: MermaidBlockProps) {
  const t = useTranslations("chat.renderers.mermaid")
  const containerRef = useRef<HTMLDivElement>(null)
  const fullscreenRef = useRef<HTMLDivElement>(null)
  // Seed from the shared render cache: a re-scrolled (or repeated) diagram
  // paints synchronously instead of flashing the loading Skeleton while
  // `mermaid.render` re-runs.
  const [svg, setSvg] = useState<string>(() => seedMermaidSvg(content))
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(() => seedMermaidSvg(content) === "")
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const { copied, copy } = useCopy({ logger: loggers.chat, scope: "chat" })

  const oversized = content.length > MERMAID_AUTO_RENDER_MAX_CHARS
  const [renderRequested, setRenderRequested] = useState(false)
  // Already cached (a remount, or a second copy of the same diagram) costs
  // nothing to paint, so don't make the user ask for it.
  const deferred = oversized && !renderRequested && svg === ""

  // Don't lay out every diagram in the transcript during the initial paint —
  // wait until each is roughly a screen away. Latches, so scrolling back and
  // forth never re-renders. A diagram already served from cache skips the
  // observer entirely.
  const near = useNearViewport(containerRef, { disabled: svg !== "" })

  const renderMermaid = useCallback(async () => {
    const themeKey = readMermaidTheme()
    const source = content.trim()

    // Cache hit → paint immediately, skip the (expensive) render entirely.
    const cached = getCachedMermaid(themeKey, source)
    if (cached !== undefined) {
      setSvg(cached)
      setError(null)
      setIsLoading(false)
      return
    }

    try {
      setIsLoading(true)
      setError(null)
      const renderedSvg = await renderMermaidCached(themeKey, source)
      setSvg(renderedSvg)
      setIsLoading(false)
    } catch (err) {
      loggers.chat.warn("mermaid render failed", {
        err: err instanceof Error ? err.message : String(err),
      })
      setError(err instanceof Error ? err.message : t("errorFallback"))
      setIsLoading(false)
    }
  }, [content, t])

  useEffect(() => {
    if (!near || deferred) return
    let mounted = true
    const doRender = async () => {
      if (mounted) {
        await renderMermaid()
      }
    }
    void doRender()
    return () => {
      mounted = false
    }
  }, [renderMermaid, near, deferred])

  // Re-render on theme change, through the one observer shared by every
  // diagram (`@cognia/mermaid/theme-source`). This block used to own a
  // `MutationObserver` on `<html>`, so a transcript with fifty diagrams ran
  // fifty observers that all woke on any attribute change, theme or not.
  useEffect(() => {
    if (deferred) return
    return subscribeMermaidTheme(() => {
      void renderMermaid()
    })
  }, [renderMermaid, deferred])

  const handleCopy = useCallback(async () => {
    await copy(content)
  }, [copy, content])

  const handleExportSvg = useCallback(() => {
    if (!svg) return
    const blob = new Blob([svg], { type: "image/svg+xml" })
    downloadBlob(blob, `diagram-${Date.now()}.svg`)
  }, [svg])

  const handleRetry = useCallback(() => {
    void renderMermaid()
  }, [renderMermaid])

  // A diagram past the auto-render budget: show the source and let the reader
  // decide. Rendering it would block the main thread for seconds, and doing
  // that to someone scrolling past a transcript is worse than asking.
  if (deferred) {
    return (
      <div
        ref={containerRef}
        className={cn("my-4 flex flex-col gap-3 rounded-lg border bg-card p-4", className)}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {t("tooLarge", { chars: content.length })}
          </p>
          <Button variant="secondary" size="sm" onClick={() => setRenderRequested(true)}>
            <AnimatedActionIcon icon={AnimatedPlayIcon} size={14} data-icon="inline-start" />
            {t("renderAnyway")}
          </Button>
        </div>
        <pre className="max-h-40 overflow-auto rounded bg-muted/50 p-2 font-mono text-xs">
          <code>{content}</code>
        </pre>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div ref={containerRef} className={cn("my-4 rounded-lg border bg-card p-4", className)}>
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (error) {
    return (
      <div
        className={cn(
          "flex flex-col gap-2 p-4 rounded-lg bg-destructive/10 border border-destructive/20",
          className
        )}
        role="alert"
        aria-label={t("error")}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <span className="text-sm font-medium">{t("error")}</span>
          </div>
          <div className="flex items-center gap-1">
            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleRetry}
              aria-label={t("retry")}
              tooltip={t("retry")}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </TooltipIconButton>
            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleCopy}
              aria-label={t("copySource")}
              tooltip={t("copySource")}
            >
              <CopyFeedbackIcon copied={copied} size={14} />
            </TooltipIconButton>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{error}</p>
        <pre className="mt-2 p-2 rounded bg-muted text-xs overflow-auto max-h-40">
          <code>{content}</code>
        </pre>
      </div>
    )
  }

  return (
    <>
      <div
        className={cn("group relative rounded-lg border bg-card overflow-hidden my-4", className)}
        role="figure"
        aria-label={t("diagramLabel")}
      >
        <div className="absolute top-2 right-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity z-10 bg-background/80 rounded-lg p-0.5">
          <TooltipIconButton
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setShowSource(!showSource)}
            aria-label={showSource ? t("hideSource") : t("showSource")}
            aria-pressed={showSource}
            tooltip={showSource ? t("hideSource") : t("showSource")}
          >
            <Code2 className="h-3.5 w-3.5" />
          </TooltipIconButton>

          <TooltipIconButton
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleCopy}
            aria-label={t("copySource")}
            tooltip={t("copySource")}
          >
            <CopyFeedbackIcon copied={copied} size={14} />
          </TooltipIconButton>

          <TooltipIconButton
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleExportSvg}
            aria-label={t("exportSvg")}
            tooltip={t("exportSvg")}
          >
            <AnimatedActionIcon icon={AnimatedDownloadIcon} size={14} />
          </TooltipIconButton>

          <TooltipIconButton
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setIsFullscreen(true)}
            aria-label={t("viewFullscreen")}
            tooltip={t("viewFullscreen")}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </TooltipIconButton>
        </div>

        {showSource && (
          <pre className="m-2 p-3 rounded-lg bg-muted/50 border text-xs overflow-auto font-mono max-h-40">
            <code>{content}</code>
          </pre>
        )}

        <div
          ref={containerRef}
          className="flex items-center justify-center overflow-auto p-4 [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>

      <Dialog open={isFullscreen} onOpenChange={setIsFullscreen}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span>{t("diagramTitle")}</span>
              <div className="flex items-center gap-1 ml-auto">
                <TooltipIconButton
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleCopy}
                  aria-label={t("copySource")}
                  tooltip={t("copySource")}
                >
                  <CopyFeedbackIcon copied={copied} size={14} />
                </TooltipIconButton>
                <TooltipIconButton
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleExportSvg}
                  aria-label={t("exportSvg")}
                  tooltip={t("exportSvg")}
                >
                  <AnimatedActionIcon icon={AnimatedDownloadIcon} size={14} />
                </TooltipIconButton>
              </div>
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div
              ref={fullscreenRef}
              className="flex items-center justify-center p-4 [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />

            <details className="group">
              <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-2">
                <Code2 className="h-4 w-4" />
                <span>{t("viewSource")}</span>
              </summary>
              <pre className="mt-2 p-4 rounded-lg bg-muted text-sm overflow-auto font-mono max-h-60">
                <code>{content}</code>
              </pre>
            </details>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default MermaidBlock
