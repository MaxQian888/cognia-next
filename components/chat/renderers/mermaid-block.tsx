"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Code2, Maximize2, RefreshCw, Workflow, ZoomIn, ZoomOut } from "lucide-react"
import { AnimatedActionIcon, CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import { DownloadIcon as AnimatedDownloadIcon } from "@/components/ui/download"
import { PlayIcon as AnimatedPlayIcon } from "@/components/ui/play"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { RichBlockAction } from "@/components/chat/renderers/rich-block/rich-block-action"
import { RichBlockError } from "@/components/chat/renderers/rich-block/rich-block-error"
import { RichBlockFrame } from "@/components/chat/renderers/rich-block/rich-block-frame"
import {
  RICH_BLOCK_FULLSCREEN_ACTION_CLASS,
  RichBlockFullscreen,
} from "@/components/chat/renderers/rich-block/rich-block-fullscreen"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { useCopy } from "@/hooks/ui/use-copy"
import { useNearViewport } from "@/hooks/chat/use-near-viewport"
import {
  buildMermaidThemeVariables,
  useChatDiagramPalette,
  type ChatDiagramPalette,
} from "@/lib/chat/diagram-palette"
import { downloadBlob } from "@/lib/files/download"
import { loggers } from "@cognia/logging"
import {
  getCachedMermaid,
  readMermaidTheme,
  renderMermaidCached,
  type MermaidRenderStyle,
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

/** Fullscreen zoom steps; 1 is the diagram's natural size. */
export const MERMAID_ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const

/**
 * The app palette as a Mermaid render style (ADR-0218): the `base` theme
 * driven by the resolved tokens, so diagrams follow the light/dark flip and
 * custom themes instead of Mermaid's stock lavender. The streaming branch
 * hands Streamdown the same variables (`streaming-text-part.tsx`).
 */
export function mermaidStyleFor(palette: ChatDiagramPalette): MermaidRenderStyle {
  return {
    key: palette.key,
    themeVariables: buildMermaidThemeVariables(palette),
    fontFamily: palette.fontFamily,
  }
}

export function MermaidBlock({ content, className }: MermaidBlockProps) {
  const t = useTranslations("chat.renderers.mermaid")
  const containerRef = useRef<HTMLDivElement>(null)
  const palette = useChatDiagramPalette()
  const style = useMemo(() => mermaidStyleFor(palette), [palette])
  const source = content.trim()

  // Seed from the shared render cache: a re-scrolled (or repeated) diagram
  // paints synchronously instead of flashing the loading state while
  // `mermaid.render` re-runs.
  const [rendered, setRendered] = useState<{ key: string; svg: string } | null>(() => {
    const cached =
      typeof document === "undefined"
        ? undefined
        : getCachedMermaid(readMermaidTheme(), source, style)
    return cached ? { key: style.key, svg: cached } : null
  })
  const [error, setError] = useState<string | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const [zoomIndex, setZoomIndex] = useState(MERMAID_ZOOM_STEPS.indexOf(1))
  const { copied, copy } = useCopy({ logger: loggers.chat, scope: "chat" })

  const svg = rendered?.svg ?? ""
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

  // `style` changes with the palette (theme flip, custom theme), which
  // re-creates this callback and re-runs the effect below: one palette
  // observer for every diagram instead of one per block.
  const renderMermaid = useCallback(async () => {
    const themeKey = readMermaidTheme()
    const cached = getCachedMermaid(themeKey, source, style)
    if (cached !== undefined) {
      setRendered({ key: style.key, svg: cached })
      setError(null)
      return
    }
    try {
      setError(null)
      const next = await renderMermaidCached(themeKey, source, style)
      setRendered({ key: style.key, svg: next })
    } catch (err) {
      loggers.chat.warn("mermaid render failed", {
        err: err instanceof Error ? err.message : String(err),
      })
      setError(err instanceof Error ? err.message : t("errorFallback"))
    }
  }, [source, style, t])

  useEffect(() => {
    if (!near || deferred) return
    let mounted = true
    void (async () => {
      if (mounted) await renderMermaid()
    })()
    return () => {
      mounted = false
    }
  }, [renderMermaid, near, deferred])

  const handleCopy = useCallback(async () => {
    await copy(content)
  }, [copy, content])

  const handleExportSvg = useCallback(() => {
    if (!svg) return
    downloadBlob(new Blob([svg], { type: "image/svg+xml" }), `diagram-${Date.now()}.svg`)
  }, [svg])

  const sourceBlock = (
    <pre className="max-h-48 overflow-auto border-b bg-muted/40 px-3 py-2 font-mono text-xs">
      <code>{content}</code>
    </pre>
  )

  if (error) {
    return (
      <RichBlockError
        className={className}
        title={t("error")}
        detail={error}
        action={
          <div className="flex items-center gap-0.5">
            <RichBlockAction label={t("retry")} onClick={() => void renderMermaid()}>
              <RefreshCw />
            </RichBlockAction>
            <RichBlockAction label={t("copySource")} onClick={handleCopy}>
              <CopyFeedbackIcon copied={copied} size={12} />
            </RichBlockAction>
          </div>
        }
      >
        <pre className="max-h-40 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs">
          <code>{content}</code>
        </pre>
      </RichBlockError>
    )
  }

  const icon = <Workflow />

  // A diagram past the auto-render budget: show the source and let the reader
  // decide. Rendering it would block the main thread for seconds, and doing
  // that to someone scrolling past a transcript is worse than asking.
  if (deferred) {
    return (
      <RichBlockFrame
        ref={containerRef}
        kind="mermaid"
        className={className}
        icon={icon}
        label={t("diagramTitle")}
        bodyClassName="space-y-2 p-(--rich-block-pad)"
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
        <pre className="max-h-40 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs">
          <code>{content}</code>
        </pre>
      </RichBlockFrame>
    )
  }

  // Loading keeps the frame and header, so the block does not jump when the
  // SVG arrives.
  if (!svg) {
    return (
      <RichBlockFrame
        ref={containerRef}
        kind="mermaid"
        className={className}
        icon={icon}
        label={t("diagramTitle")}
        bodyClassName="p-(--rich-block-pad)"
        aria-busy
      >
        <Skeleton className="h-32 w-full" />
      </RichBlockFrame>
    )
  }

  const zoom = MERMAID_ZOOM_STEPS[zoomIndex]

  return (
    <>
      <RichBlockFrame
        ref={containerRef}
        kind="mermaid"
        className={className}
        role="figure"
        aria-label={t("diagramLabel")}
        icon={icon}
        label={t("diagramTitle")}
        actions={
          <>
            <RichBlockAction
              label={showSource ? t("hideSource") : t("showSource")}
              aria-pressed={showSource}
              onClick={() => setShowSource(!showSource)}
            >
              <Code2 />
            </RichBlockAction>
            <RichBlockAction label={t("copySource")} onClick={handleCopy}>
              <CopyFeedbackIcon copied={copied} size={12} />
            </RichBlockAction>
            <RichBlockAction label={t("exportSvg")} onClick={handleExportSvg}>
              <AnimatedActionIcon icon={AnimatedDownloadIcon} size={12} />
            </RichBlockAction>
            <RichBlockAction label={t("viewFullscreen")} onClick={() => setIsFullscreen(true)}>
              <Maximize2 />
            </RichBlockAction>
          </>
        }
      >
        {showSource ? sourceBlock : null}
        <div
          data-mermaid-svg
          className="flex items-center justify-center overflow-x-auto p-(--rich-block-pad) [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </RichBlockFrame>

      <RichBlockFullscreen
        open={isFullscreen}
        onOpenChange={setIsFullscreen}
        testId="mermaid-fullscreen"
        icon={icon}
        title={t("diagramTitle")}
        subtitle={<span className="tabular-nums">{Math.round(zoom * 100)}%</span>}
        actions={
          <>
            <TooltipIconButton
              variant="ghost"
              size="icon"
              className={RICH_BLOCK_FULLSCREEN_ACTION_CLASS}
              disabled={zoomIndex === 0}
              onClick={() => setZoomIndex((index) => Math.max(0, index - 1))}
              aria-label={t("zoomOut")}
              tooltip={t("zoomOut")}
            >
              <ZoomOut />
            </TooltipIconButton>
            <TooltipIconButton
              variant="ghost"
              size="icon"
              className={RICH_BLOCK_FULLSCREEN_ACTION_CLASS}
              disabled={zoomIndex === MERMAID_ZOOM_STEPS.length - 1}
              onClick={() =>
                setZoomIndex((index) => Math.min(MERMAID_ZOOM_STEPS.length - 1, index + 1))
              }
              aria-label={t("zoomIn")}
              tooltip={t("zoomIn")}
            >
              <ZoomIn />
            </TooltipIconButton>
            <TooltipIconButton
              variant="ghost"
              size="icon"
              className={RICH_BLOCK_FULLSCREEN_ACTION_CLASS}
              onClick={handleCopy}
              aria-label={t("copySource")}
              tooltip={t("copySource")}
            >
              <CopyFeedbackIcon copied={copied} size={16} />
            </TooltipIconButton>
            <TooltipIconButton
              variant="ghost"
              size="icon"
              className={RICH_BLOCK_FULLSCREEN_ACTION_CLASS}
              onClick={handleExportSvg}
              aria-label={t("exportSvg")}
              tooltip={t("exportSvg")}
            >
              <AnimatedActionIcon icon={AnimatedDownloadIcon} size={16} />
            </TooltipIconButton>
          </>
        }
      >
        {isFullscreen ? (
          // `zoom` (not a transform) so the scroll area grows with the diagram
          // and a zoomed-in graph pans with ordinary scrolling.
          <div
            data-testid="mermaid-fullscreen-canvas"
            data-zoom={zoom}
            className="flex min-h-full items-center justify-center p-6 [&_svg]:h-auto [&_svg]:max-w-none"
            style={{ zoom }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : null}
      </RichBlockFullscreen>
    </>
  )
}

export default MermaidBlock
