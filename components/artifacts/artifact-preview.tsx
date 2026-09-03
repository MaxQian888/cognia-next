"use client"

/**
 * ArtifactPreview - Live preview for HTML, React, SVG, Mermaid, Chart, Math,
 * Markdown documents, and Jupyter notebooks. Sanitizes HTML/SVG via DOMPurify
 * and isolates scripted artifacts in an opaque-origin sandboxed iframe served
 * entirely from the offline runtime in `public/artifact-runtime/`.
 *
 * The scripted frames (React, and the opt-in interactive HTML mode) never carry
 * an inline script and never eval: measured in a packaged Tauri shell
 * (ADR-0158), an `about:srcdoc` child inherits `tauri.conf.json`'s CSP, which
 * grants neither `'unsafe-inline'` nor `'unsafe-eval'`. Code reaches the frame
 * as a same-origin bundle plus a `blob:` script.
 */

import { useCallback, useEffect, useMemo, useRef, useState, Component } from "react"
import { useTranslations } from "next-intl"
import { AlertCircle, RefreshCw, Loader2, PlayIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { cn } from "@/lib/utils"
import {
  applyArtifactThemeVariables,
  DIAGRAM_DESIGN_THEME_DEFAULTS,
  DIAGRAM_DESIGN_THEME_KEYS,
  renderHTML,
  renderSVG,
  getInteractiveHtmlShellHtml,
  getReactShellHtml,
  escapeHtml,
} from "@/lib/artifacts"
import type { ArtifactFrameRuntime } from "@/lib/artifacts/preview-utils"
import { compileInteractiveHtml, hasInteractiveContent } from "@/lib/artifacts/interactive-html"
import { useSettingsStore } from "@/stores/settings"
import { useThemeCssVars } from "@/lib/appearance/use-theme-css-vars"
import { loggers } from "@cognia/logging"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { registerArtifactPreviewNode } from "@/lib/artifacts/preview-registry"
import {
  ArtifactFrameCaptureError,
  ArtifactFrameCaptureTimeoutError,
  registerArtifactFrameCapturer,
  type ArtifactFrameSnapshot,
} from "@/lib/artifacts/frame-capture-registry"
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

/**
 * How long a scripted frame may stay silent before the panel calls it a
 * runtime failure. Generous enough for a cold parse of the React bundle, far
 * short of the 15 seconds the CDN watchdog it replaces used to burn.
 */
const SHELL_READY_TIMEOUT_MS = 8000

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
      className="absolute right-2 top-2 z-20 rounded-pill bg-background/90 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground shadow-sm"
    >
      {state}
    </div>
  )
}

export function ArtifactPreview({ artifact, className }: ArtifactPreviewProps) {
  const t = useTranslations("artifactPreview")
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // Mirrors `error` for the capturer, which is a long-lived closure and would
  // otherwise read a stale value from the render it was created in.
  const errorRef = useRef<string | null>(null)
  // `chart` / `mermaid` / `math` draw as live React in this tree, so the only
  // way to rasterise them is to hand html2canvas the mounted node. Registering
  // it here is what makes "export as PNG" possible for those types at all —
  // there is no serialisable source to re-render off-screen the way html and
  // svg can be. Iframe transports register a CAPTURER instead, below: their
  // frame is opaque-origin, so it has to be asked for a snapshot rather than
  // read (`lib/artifacts/frame-capture-registry.ts`).
  const registerRendererNode = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return undefined
      // React 19 ref-callback cleanup: the disposer runs on unmount, so a
      // detached node can never be handed to the exporter.
      return registerArtifactPreviewNode(artifact.id, node)
    },
    [artifact.id]
  )
  const diagramThemeVariables = useThemeCssVars(
    DIAGRAM_DESIGN_THEME_KEYS,
    DIAGRAM_DESIGN_THEME_DEFAULTS
  )
  const diagramThemeVariablesRef = useRef(diagramThemeVariables)
  const [error, setError] = useState<string | null>(null)
  const [key, setKey] = useState(0)
  /** Which `key` generation `lastRenderedRef` describes. */
  const lastRenderedKeyRef = useRef(0)
  const adapter = getArtifactRuntimeAdapter(artifact.type)
  const renderPlan = resolveArtifactRenderPlan(artifact)
  const needsIframe = adapter.transport === "iframe"
  const [isLoading, setIsLoading] = useState(needsIframe)
  const [iframeHeight, setIframeHeight] = useState<string | undefined>(undefined)
  // A plugin renderer may report `unsupported`, which is neither an error nor a
  // successful render; folding it into `ready` (as this used to) made the panel
  // claim a preview it never produced.
  const [unsupported, setUnsupported] = useState(false)

  // ---- scripted frames (react + the opt-in interactive HTML mode) ----------
  const interactiveHtmlEnabled = useSettingsStore(
    (state) => state.settings?.artifacts?.interactiveHtml === true
  )
  // Authorisation is PER ARTIFACT: the grant is the artifact's own id, so
  // moving the panel to a different artifact silently un-grants it without any
  // reset effect. The setting says "you may offer this"; the button says "run
  // this one".
  const [interactiveArtifactId, setInteractiveArtifactId] = useState<string | null>(null)
  const offersInteractive =
    artifact.type === "html" && interactiveHtmlEnabled && hasInteractiveContent(artifact.content)
  const interactiveActive = offersInteractive && interactiveArtifactId === artifact.id
  const frameMode: "html" | "svg" | "react" | "interactive" | "text" =
    artifact.type === "react"
      ? "react"
      : artifact.type === "html"
        ? interactiveActive
          ? "interactive"
          : "html"
        : artifact.type === "svg"
          ? "svg"
          : "text"
  const needsRuntime = frameMode === "react" || frameMode === "interactive"

  // Answering an export request. A scripted frame is opaque-origin, so the
  // exporter cannot read it and the frame cannot rasterise itself either (see
  // `frame-capture-registry.ts`). It asks, the frame serialises, we resolve.
  const pendingCaptures = useRef(
    new Map<
      string,
      { resolve: (snapshot: ArtifactFrameSnapshot) => void; reject: (error: Error) => void }
    >()
  )
  const captureSeq = useRef(0)

  useEffect(() => {
    if (!needsIframe) return undefined
    const pending = pendingCaptures.current
    const dispose = registerArtifactFrameCapturer(artifact.id, (timeoutMs) => {
      const target = iframeRef.current?.contentWindow
      if (!target) {
        return Promise.reject(new ArtifactFrameCaptureError("preview frame is not mounted"))
      }
      // A frame that failed to render would happily serialise its empty body,
      // and the export would be a blank PNG with no explanation. Refuse
      // instead: the export is "what you see", and there is nothing to see.
      if (errorRef.current) {
        return Promise.reject(new ArtifactFrameCaptureError(errorRef.current))
      }
      captureSeq.current += 1
      const requestId = `capture-${captureSeq.current}`
      return new Promise<ArtifactFrameSnapshot>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          reject(new ArtifactFrameCaptureTimeoutError(artifact.id, timeoutMs))
        }, timeoutMs)
        pending.set(requestId, {
          resolve: (snapshot) => {
            clearTimeout(timer)
            pending.delete(requestId)
            resolve(snapshot)
          },
          reject: (error) => {
            clearTimeout(timer)
            pending.delete(requestId)
            reject(error)
          },
        })
        target.postMessage({ type: "capture-snapshot", requestId }, "*")
      })
    })
    return () => {
      dispose()
      // Unmounting mid-export must not leave a caller hanging until its timeout.
      for (const [id, entry] of pending) {
        pending.delete(id)
        entry.reject(new ArtifactFrameCaptureError("preview closed before the capture finished"))
      }
    }
  }, [artifact.id, needsIframe])

  const [frameRuntime, setFrameRuntime] = useState<ArtifactFrameRuntime | null>(null)

  const runtimeHealth: ArtifactRuntimeHealth = error
    ? "error"
    : isLoading
      ? "loading"
      : unsupported
        ? "unsupported"
        : "ready"
  const setArtifactRuntimeHealth = useArtifactStore((state) => state.setArtifactRuntimeHealth)

  useEffect(() => {
    diagramThemeVariablesRef.current = diagramThemeVariables
  }, [diagramThemeVariables])

  // The capturer is a long-lived closure, so it reads the failure through a ref
  // rather than the `error` of the render that created it.
  useEffect(() => {
    errorRef.current = error
  }, [error])

  // `useTranslations()` hands back a fresh function on every render. Anything
  // that reads it from an effect dependency list therefore re-runs on every
  // render — which, for the async runtime effect below, is an endless
  // load → setState → load loop that never lets the frame settle.
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  })

  // Persist only settled outcomes, so "which artifacts are broken?" survives a
  // reload and the workspace runtime filter has something to match. `loading`
  // is never written — it is a property of this render, not of the artifact.
  useEffect(() => {
    if (runtimeHealth === "loading") return
    setArtifactRuntimeHealth(artifact.id, runtimeHealth, error ?? undefined)
  }, [artifact.id, error, runtimeHealth, setArtifactRuntimeHealth])

  // Re-push the palette on a theme flip WITHOUT re-rendering the document, so
  // a live preview restyles in place. Applies to every same-origin frame, not
  // just the diagram-design profile — an SVG or plain HTML preview was
  // otherwise stuck on a light backdrop in a dark app.
  useEffect(() => {
    // Only the same-origin frames can be written into. The scripted ones are
    // opaque-origin, so their palette rides `artifact-preview-parent-context`.
    if (frameMode !== "html" && frameMode !== "svg") return
    const doc = iframeRef.current?.contentDocument
    if (doc) applyArtifactThemeVariables(doc, diagramThemeVariables)
  }, [frameMode, diagramThemeVariables])
  const widgetMetadata = artifact.metadata?.widget
  const effectiveIframeHeight =
    widgetMetadata?.sizing === "content-height" ? iframeHeight : undefined

  const syncParentContext = useCallback(() => {
    const target = iframeRef.current?.contentWindow
    // A scripted frame always needs this message: it is the ONLY channel that
    // reaches an opaque-origin document, so the palette rides it too.
    if (!target || (!widgetMetadata && !needsRuntime)) {
      return
    }

    target.postMessage(
      {
        type: "artifact-preview-parent-context",
        theme: widgetMetadata?.theme || "inherit",
        sizing: widgetMetadata?.sizing || "auto",
        hostStrategy: artifact.metadata?.hostStrategy,
        themeVariables: needsRuntime ? diagramThemeVariablesRef.current : undefined,
      },
      "*"
    )
  }, [artifact.metadata?.hostStrategy, needsRuntime, widgetMetadata])

  // What is currently painted in the iframe. The render effect keys on
  // `artifact.content`, and a Canvas split view drives that from the live
  // buffer — so without this every commit re-parsed and rewrote the whole
  // document even when nothing about it had changed.
  const lastRenderedRef = useRef<{
    id: string
    type: string
    mode: string
    rendererProfile: string | undefined
    content: string
  } | null>(null)
  /** True once the in-frame bootstrap has announced itself for THIS document. */
  const shellReadyRef = useRef(false)
  /**
   * A scripted frame that never announces itself is the shape a CSP refusal
   * takes: the bundles are served, the frame loads, and nothing runs. Without
   * this the panel would spin forever instead of saying so.
   */
  const shellDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The offline runtime under `public/artifact-runtime/`. Imported lazily: a
  // chart preview has no business pulling in the JSX worker plumbing.
  useEffect(() => {
    if (!needsRuntime) return
    let cancelled = false
    void import("@/lib/artifacts/react-runtime-loader")
      .then((module) => module.loadArtifactReactRuntime())
      .then((runtime) => {
        if (cancelled) return
        setFrameRuntime(runtime)
      })
      .catch((err) => {
        if (cancelled) return
        loggers.ui.error("artifacts.preview.runtime-unavailable", err, {
          artifactId: artifact.id,
          artifactType: artifact.type,
        })
        // Synchronous and specific, in place of the old 15-second CDN timeout.
        setFrameRuntime(null)
        setIsLoading(false)
        setError(tRef.current("runtimeInitFailed"))
      })
    return () => {
      cancelled = true
    }
  }, [artifact.id, artifact.type, needsRuntime])

  // Compiled once per (artifact, content) and read back when the frame reports
  // ready — the markup goes into `srcdoc`, the scripts go over postMessage.
  const interactiveProgram = useMemo(
    () => (frameMode === "interactive" ? compileInteractiveHtml(artifact.content) : null),
    [artifact.content, frameMode]
  )
  const interactiveProgramRef = useRef(interactiveProgram)
  useEffect(() => {
    interactiveProgramRef.current = interactiveProgram
  }, [interactiveProgram])

  /**
   * Push the artifact into a live scripted frame. React code is transformed by
   * the host's Worker first, so the frame never needs Babel or `'unsafe-eval'`.
   */
  const pushScriptedContent = useCallback(async () => {
    const target = iframeRef.current?.contentWindow
    if (!target) return
    try {
      if (frameMode === "react") {
        const { transformArtifactJsx } = await import("@/lib/artifacts/react-runtime-loader")
        const { code, isModule } = await transformArtifactJsx(artifact.content)
        target.postMessage({ type: "render-component", code, isModule }, "*")
        return
      }
      if (frameMode === "interactive") {
        target.postMessage(
          { type: "run-scripts", scripts: interactiveProgramRef.current?.scripts ?? [] },
          "*"
        )
      }
    } catch (err) {
      loggers.ui.error("artifacts.preview.scripted-push-failed", err, {
        artifactId: artifact.id,
        frameMode,
      })
      setIsLoading(false)
      setError(err instanceof Error ? err.message : tRef.current("previewError"))
    }
  }, [artifact.content, artifact.id, frameMode])

  useEffect(() => {
    if (!needsIframe) return
    // A scripted frame cannot be seeded before the runtime URLs are known.
    if (needsRuntime && !frameRuntime) return

    const last = lastRenderedRef.current
    const unchanged =
      last !== null &&
      last.id === artifact.id &&
      last.type === artifact.type &&
      last.mode === frameMode &&
      last.rendererProfile === artifact.metadata?.rendererProfile &&
      last.content === artifact.content
    // `key` is the manual-refresh counter; a refresh must re-render even when
    // the content is byte-identical, which is the whole point of the button.
    if (unchanged && lastRenderedKeyRef.current === key) return
    lastRenderedKeyRef.current = key

    // Re-rendering INTO a live document does not need the loading curtain: the
    // frame already has something on screen, and raising it made every
    // keystroke in a Canvas split view flash a full-cover backdrop blur.
    const isFreshFrame =
      last === null ||
      last.id !== artifact.id ||
      last.type !== artifact.type ||
      last.mode !== frameMode

    // A React frame that is already up takes new code over postMessage. That is
    // what makes an edit repaint in place instead of re-navigating the iframe —
    // the old shell had to re-navigate because it built a NEW root per message.
    const canRenderInPlace = frameMode === "react" && !isFreshFrame && shellReadyRef.current

    const rafId =
      isFreshFrame && !canRenderInPlace
        ? requestAnimationFrame(() => {
            setError(null)
            setIsLoading(true)
          })
        : null

    const doRenderPreview = () => {
      if (!iframeRef.current) return

      const iframe = iframeRef.current

      try {
        switch (frameMode) {
          case "html": {
            const doc = iframe.contentDocument
            if (!doc) return
            renderHTML(doc, artifact.content, {
              rendererProfile: artifact.metadata?.rendererProfile,
              themeVariables: diagramThemeVariablesRef.current,
            })
            break
          }
          case "svg": {
            const doc = iframe.contentDocument
            if (!doc) return
            renderSVG(doc, artifact.content, diagramThemeVariablesRef.current)
            break
          }
          case "react": {
            if (!frameRuntime) return
            if (canRenderInPlace) {
              void pushScriptedContent()
              break
            }
            shellReadyRef.current = false
            iframe.srcdoc = getReactShellHtml(frameRuntime)
            break
          }
          case "interactive": {
            if (!frameRuntime || !interactiveProgramRef.current) return
            // The markup itself changed, so the document is rebuilt; the
            // scripts follow over postMessage once the shell reports ready.
            shellReadyRef.current = false
            iframe.srcdoc = getInteractiveHtmlShellHtml(
              interactiveProgramRef.current.html,
              frameRuntime
            )
            break
          }
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

    const commit = () => {
      doRenderPreview()
      lastRenderedRef.current = {
        id: artifact.id,
        type: artifact.type,
        mode: frameMode,
        rendererProfile: artifact.metadata?.rendererProfile,
        content: artifact.content,
      }
      // A scripted frame is still booting; it drops the curtain itself when the
      // bootstrap reports `artifact-preview-ready`.
      if (frameMode !== "react" && frameMode !== "interactive") {
        setIsLoading(false)
        return
      }
      if (shellReadyRef.current) return
      if (shellDeadlineRef.current) clearTimeout(shellDeadlineRef.current)
      shellDeadlineRef.current = setTimeout(() => {
        if (shellReadyRef.current) return
        loggers.ui.error("artifacts.preview.shell-never-ready", undefined, {
          artifactId: artifact.id,
          frameMode,
        })
        setIsLoading(false)
        setError(tRef.current("runtimeInitFailed"))
      }, SHELL_READY_TIMEOUT_MS)
    }

    // The 100ms delay exists to let a freshly-keyed iframe attach its document.
    // An already-live frame needs no such wait.
    if (!isFreshFrame) {
      commit()
      return
    }
    const timer = setTimeout(commit, 100)

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      clearTimeout(timer)
    }
  }, [
    artifact.id,
    artifact.content,
    artifact.metadata?.rendererProfile,
    artifact.type,
    frameMode,
    frameRuntime,
    key,
    needsIframe,
    needsRuntime,
    pushScriptedContent,
    t,
  ])

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
      if (event.data?.type === "artifact-shell-ready") {
        // The bootstrap is listening; hand it the strings, the palette and the
        // code. Nothing before this point can reach an opaque-origin frame.
        shellReadyRef.current = true
        if (shellDeadlineRef.current) {
          clearTimeout(shellDeadlineRef.current)
          shellDeadlineRef.current = null
        }
        event.source?.postMessage(
          {
            type: "artifact-shell-config",
            messages: {
              noComponentFound: t("noComponentFound"),
              runtimeInitFailed: t("runtimeInitFailed"),
            },
          },
          { targetOrigin: "*" }
        )
        syncParentContext()
        void pushScriptedContent()
        return
      }
      if (event.data?.type === "artifact-capture-result") {
        const entry = pendingCaptures.current.get(event.data.requestId)
        entry?.resolve({
          html: String(event.data.html ?? ""),
          width: Number(event.data.width) || 0,
          height: Number(event.data.height) || 0,
        })
        return
      }
      if (event.data?.type === "artifact-capture-error") {
        const entry = pendingCaptures.current.get(event.data.requestId)
        entry?.reject(new ArtifactFrameCaptureError(String(event.data.message ?? "capture failed")))
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
    return () => {
      window.removeEventListener("message", handleMessage)
      if (shellDeadlineRef.current) clearTimeout(shellDeadlineRef.current)
    }
  }, [
    artifact.id,
    artifact.type,
    pushScriptedContent,
    syncParentContext,
    t,
    widgetMetadata?.sizing,
  ])

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
        <div
          ref={registerRendererNode}
          className={cn("relative h-full w-full overflow-auto bg-background", className)}
        >
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
        <div
          ref={registerRendererNode}
          className={cn("relative h-full w-full overflow-auto bg-background", className)}
        >
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
        <div
          ref={registerRendererNode}
          className={cn("relative h-full w-full overflow-auto bg-background p-4", className)}
        >
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
      // A column only when a notice bar is present, so the frame gives up the
      // rows above it instead of overflowing the panel.
      className={cn("relative h-full w-full", offersInteractive && "flex flex-col", className)}
      role="region"
      aria-label={t("previewTitle", { title: artifact.title })}
    >
      <RuntimeHealthBadge state={runtimeHealth} />
      {offersInteractive && (
        <div
          data-testid="artifact-interactive-bar"
          className="flex items-center justify-between gap-3 border-b bg-muted/40 px-3 py-2 text-xs"
        >
          <span className="min-w-0 truncate text-muted-foreground">
            {interactiveActive ? t("interactiveRunningHint") : t("interactiveOfferHint")}
          </span>
          {!interactiveActive && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              data-testid="artifact-interactive-run"
              onClick={() => setInteractiveArtifactId(artifact.id)}
            >
              <PlayIcon className="mr-1 size-3" />
              {t("interactiveRunAction")}
            </Button>
          )}
        </div>
      )}
      {interactiveActive && (interactiveProgram?.droppedExternalScripts.length ?? 0) > 0 && (
        <div
          data-testid="artifact-interactive-dropped"
          className="border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
          role="status"
        >
          {t("interactiveDroppedScripts", {
            count: interactiveProgram?.droppedExternalScripts.length ?? 0,
          })}
        </div>
      )}
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
        // `bg-white` here made the frame itself a light rectangle in a dark
        // app, before its document even painted.
        className={cn(
          "w-full border-0 bg-background",
          !effectiveIframeHeight && (offersInteractive ? "min-h-0 flex-1" : "h-full")
        )}
        // An interactive HTML frame drops `allow-same-origin` — an opaque
        // origin is what keeps a scripted artifact away from the host, its
        // cookies and its storage. The static render keeps same-origin because
        // it is written in through `contentDocument`.
        sandbox={needsRuntime ? "allow-scripts" : adapter.sandbox}
        title={t("previewTitle", { title: artifact.title })}
        style={effectiveIframeHeight ? { height: effectiveIframeHeight } : undefined}
        onLoad={() => {
          // A scripted frame is NOT ready on `load` — its bootstrap says so
          // itself, and pushing code before that races the script tags.
          if (needsRuntime) return
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
