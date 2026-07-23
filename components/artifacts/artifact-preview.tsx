"use client"

/**
 * ArtifactPreview - Live preview for HTML, React, SVG, Mermaid, Chart, Math,
 * Markdown documents, and Jupyter notebooks. Sanitizes HTML/SVG via DOMPurify
 * and isolates React in a sandboxed iframe with CSP-locked CDN dependencies.
 */

import { useCallback, useEffect, useRef, useState, Component } from "react"
import { useTranslations } from "next-intl"
import { AlertCircle, RefreshCw, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { cn } from "@/lib/utils"
import { renderHTML, renderSVG, getReactShellHtml, escapeHtml } from "@/lib/artifacts"
import { loggers } from "@cognia/logging"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type { ArtifactRuntimeHealth } from "@/types/artifact/artifact"
import type { Artifact, PreviewErrorBoundaryProps, PreviewErrorBoundaryState } from "@/types"
import {
  ArtifactRenderer,
  PluginArtifactRendererHost,
  resolveArtifactRenderPlan,
} from "./artifact-renderers"
import { JupyterRenderer } from "./jupyter-renderer"
import { getArtifactRuntimeAdapter } from "./runtime-adapters"

interface ArtifactPreviewProps {
  artifact: Artifact
  className?: string
}

/**
 * Error boundary for artifact preview components
 */
class PreviewErrorBoundary extends Component<PreviewErrorBoundaryProps, PreviewErrorBoundaryState> {
  constructor(props: PreviewErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): PreviewErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.props.onError?.(error, errorInfo)
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }
      return (
        <Alert variant="destructive" className="m-4" role="alert" aria-live="assertive">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">
                  {this.props.errorMessage || "Preview failed to render"}
                </p>
                {this.state.error?.message && (
                  <p className="text-xs mt-1 opacity-80">{this.state.error.message}</p>
                )}
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={this.handleRetry}
                // i18n-exempt: class error boundary cannot use hooks; pre-existing aria label
                aria-label="Retry preview"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )
    }
    return this.props.children
  }
}

function PreviewLoading({ message }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin" />
      <p className="text-sm">{message || "Loading preview..."}</p>
    </div>
  )
}

function RuntimeHealthBadge({ state }: { state: ArtifactRuntimeHealth }) {
  return (
    <div
      data-testid="runtime-health-badge"
      data-state={state}
      className="absolute right-2 top-2 z-20 rounded-full bg-background/90 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground shadow-sm"
    >
      {state}
    </div>
  )
}

export function ArtifactPreview({ artifact, className }: ArtifactPreviewProps) {
  const t = useTranslations("artifactPreview")
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [key, setKey] = useState(0)
  const adapter = getArtifactRuntimeAdapter(artifact.type)
  const renderPlan = resolveArtifactRenderPlan(artifact)
  const needsIframe = adapter.transport === "iframe"
  const [isLoading, setIsLoading] = useState(needsIframe)
  const [iframeHeight, setIframeHeight] = useState<string | undefined>(undefined)
  // A plugin renderer may report `unsupported`, which is neither an error nor a
  // successful render; folding it into `ready` (as this used to) made the panel
  // claim a preview it never produced.
  const [unsupported, setUnsupported] = useState(false)
  const runtimeHealth: ArtifactRuntimeHealth = error
    ? "error"
    : isLoading
      ? "loading"
      : unsupported
        ? "unsupported"
        : "ready"
  const setArtifactRuntimeHealth = useArtifactStore((state) => state.setArtifactRuntimeHealth)

  // Persist only settled outcomes, so "which artifacts are broken?" survives a
  // reload and the workspace runtime filter has something to match. `loading`
  // is never written — it is a property of this render, not of the artifact.
  useEffect(() => {
    if (runtimeHealth === "loading") return
    setArtifactRuntimeHealth(artifact.id, runtimeHealth, error ?? undefined)
  }, [artifact.id, error, runtimeHealth, setArtifactRuntimeHealth])
  const widgetMetadata = artifact.metadata?.widget
  const effectiveIframeHeight =
    widgetMetadata?.sizing === "content-height" ? iframeHeight : undefined

  const syncParentContext = useCallback(() => {
    if (!widgetMetadata || !iframeRef.current?.contentWindow) {
      return
    }

    iframeRef.current.contentWindow.postMessage(
      {
        type: "artifact-preview-parent-context",
        theme: widgetMetadata.theme || "inherit",
        sizing: widgetMetadata.sizing || "auto",
        hostStrategy: artifact.metadata?.hostStrategy,
      },
      "*"
    )
  }, [artifact.metadata?.hostStrategy, widgetMetadata])

  useEffect(() => {
    if (!needsIframe) return

    const rafId = requestAnimationFrame(() => {
      setError(null)
      setIsLoading(true)
    })

    const doRenderPreview = () => {
      if (!iframeRef.current) return

      const iframe = iframeRef.current

      try {
        switch (artifact.type) {
          case "html": {
            const doc = iframe.contentDocument
            if (!doc) return
            renderHTML(doc, artifact.content)
            break
          }
          case "svg": {
            const doc = iframe.contentDocument
            if (!doc) return
            renderSVG(doc, artifact.content)
            break
          }
          case "react":
            iframe.srcdoc = getReactShellHtml({
              cdnLoadTitle: t("cdnLoadTitle"),
              cdnLoadDescription: t("cdnLoadDescription"),
              noComponentFound: t("noComponentFound"),
            })
            break
          default: {
            const doc = iframe.contentDocument
            if (doc) {
              doc.body.innerHTML = `<pre>${escapeHtml(artifact.content)}</pre>`
            }
          }
        }
      } catch (err) {
        loggers.ui.error("artifacts.preview.render-failed", err, {
          artifactId: artifact.id,
          artifactType: artifact.type,
        })
        setError(err instanceof Error ? err.message : t("previewError"))
      }
    }

    const timer = setTimeout(() => {
      doRenderPreview()
      setIsLoading(false)
    }, 100)

    return () => {
      cancelAnimationFrame(rafId)
      clearTimeout(timer)
    }
  }, [artifact.id, artifact.content, artifact.type, key, needsIframe, t])

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      if (event.data?.type === "artifact-preview-error") {
        loggers.ui.warn("artifacts.preview.iframe-error", {
          artifactId: artifact.id,
          artifactType: artifact.type,
          message: event.data.message,
        })
        setError(event.data.message || t("previewError"))
        return
      }
      if (event.data?.type === "artifact-preview-ready") {
        setIsLoading(false)
        syncParentContext()
        return
      }
      if (
        event.data?.type === "artifact-preview-resize" &&
        widgetMetadata?.sizing === "content-height" &&
        typeof event.data.height === "number" &&
        Number.isFinite(event.data.height) &&
        event.data.height > 0
      ) {
        setIframeHeight(`${event.data.height}px`)
      }
    }
    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [artifact.id, artifact.type, syncParentContext, t, widgetMetadata?.sizing])

  const handleRefresh = () => {
    setKey((k) => k + 1)
  }

  const fallbackRenderer = (
    <ArtifactRenderer
      type={adapter.rendererType || "code"}
      content={artifact.content}
      artifact={undefined}
      chartType={artifact.metadata?.chartType}
      className={adapter.rendererType === "chart" ? "min-h-[300px]" : "min-h-full"}
    />
  )

  if (renderPlan.owner === "plugin" && renderPlan.pluginRenderer) {
    return (
      <PreviewErrorBoundary errorMessage={t("previewFailed")}>
        <div className={cn("relative h-full w-full overflow-auto bg-background", className)}>
          <RuntimeHealthBadge state={runtimeHealth} />
          <PluginArtifactRendererHost
            artifact={artifact}
            renderer={renderPlan.pluginRenderer}
            className="min-h-full"
            fallback={fallbackRenderer}
            onRuntimeStateChange={(state, nextError) => {
              setIsLoading(state === "loading")
              setUnsupported(state === "unsupported")
              setError(state === "error" ? nextError || t("previewError") : null)
            }}
          />
        </div>
      </PreviewErrorBoundary>
    )
  }

  if (renderPlan.owner === "builtin" && adapter.rendererType !== "chart") {
    return (
      <PreviewErrorBoundary errorMessage={t("previewFailed")}>
        <div className={cn("relative h-full w-full overflow-auto bg-background", className)}>
          <RuntimeHealthBadge state={runtimeHealth} />
          <ArtifactRenderer
            type={adapter.rendererType || artifact.type}
            content={artifact.content}
            artifact={artifact}
            className="min-h-full"
          />
        </div>
      </PreviewErrorBoundary>
    )
  }

  if (renderPlan.owner === "builtin" && adapter.rendererType === "chart") {
    return (
      <PreviewErrorBoundary errorMessage={t("previewFailed")}>
        <div className={cn("relative h-full w-full overflow-auto bg-background p-4", className)}>
          <RuntimeHealthBadge state={runtimeHealth} />
          <ArtifactRenderer
            type="chart"
            content={artifact.content}
            artifact={artifact}
            chartType={artifact.metadata?.chartType}
            className="min-h-[300px]"
          />
        </div>
      </PreviewErrorBoundary>
    )
  }

  if (renderPlan.owner === "jupyter") {
    return (
      <PreviewErrorBoundary errorMessage={t("previewFailed")}>
        <div
          className={cn("relative h-full w-full min-w-0 overflow-hidden bg-background", className)}
        >
          <RuntimeHealthBadge state={runtimeHealth} />
          <JupyterRenderer content={artifact.content} className="h-full min-w-0" />
        </div>
      </PreviewErrorBoundary>
    )
  }

  // Default: iframe-based rendering for HTML, SVG, React
  return (
    <div
      data-testid="artifact-preview"
      className={cn("relative h-full w-full", className)}
      role="region"
      aria-label={t("previewTitle", { title: artifact.title })}
    >
      <RuntimeHealthBadge state={runtimeHealth} />
      {isLoading && (
        <div className="absolute inset-0 z-20 bg-background/80 backdrop-blur-sm">
          <PreviewLoading message={t("loadingPreview")} />
        </div>
      )}
      {error && (
        <div
          className="absolute top-2 left-2 right-2 z-10 flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-destructive text-sm"
          role="alert"
          aria-live="assertive"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <Button size="sm" variant="ghost" onClick={handleRefresh}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      )}
      <iframe
        ref={iframeRef}
        key={key}
        className={cn("w-full border-0 bg-white", !effectiveIframeHeight && "h-full")}
        sandbox={adapter.sandbox}
        title={t("previewTitle", { title: artifact.title })}
        style={effectiveIframeHeight ? { height: effectiveIframeHeight } : undefined}
        onLoad={() => {
          if (artifact.type === "react") {
            iframeRef.current?.contentWindow?.postMessage(
              { type: "render-component", code: artifact.content },
              "*"
            )
          }
          syncParentContext()
          setIsLoading(false)
        }}
        onError={() => {
          setIsLoading(false)
          setError(t("iframeLoadError"))
        }}
      />
    </div>
  )
}
