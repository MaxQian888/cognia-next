"use client"

/**
 * Artifact Renderers - Specialized renderers for different artifact types.
 * Adapted from Cognia: re-exports cognia-next's chat renderers (Mermaid /
 * Math / Code / Markdown), lazy-loads ChartRenderer, and supports the
 * renderer-registry plugin extension surface.
 */

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { MermaidBlock } from "@/components/chat/renderers/mermaid-block"
import { MathBlock } from "@/components/chat/renderers/math-block"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { MarkdownRenderer as ChatMarkdownRenderer } from "@/components/chat/markdown-renderer"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { cn } from "@/lib/utils"
import {
  getShikiLanguage,
  resolveRegisteredArtifactRenderer,
  type PluginArtifactRenderer,
} from "@/lib/artifacts"
import type { Artifact, ArtifactRuntimeHealth } from "@/types"
import type { ChartDataPoint } from "./chart-renderer"
import { getArtifactRuntimeAdapter } from "./runtime-adapters"

// Lazy-load ChartRenderer to avoid loading ~200KB recharts in initial bundle
const LazyChartRenderer = lazy(() =>
  import("./chart-renderer").then((m) => ({ default: m.ChartRenderer }))
)

export { MermaidBlock as MermaidRenderer } from "@/components/chat/renderers/mermaid-block"
export { MathBlock as MathRenderer } from "@/components/chat/renderers/math-block"
export { CodeBlock as CodeRenderer } from "@/components/chat/renderers/code-block"
export { MarkdownRenderer } from "@/components/chat/markdown-renderer"

export type { ChartDataPoint } from "./chart-renderer"

export type ArtifactRendererOwner = "plugin" | "builtin" | "runtime" | "jupyter"

export interface ArtifactRenderPlan {
  owner: ArtifactRendererOwner
  pluginRenderer?: PluginArtifactRenderer
  rendererType?: "code" | "document" | "mermaid" | "chart" | "math"
}

function ChartLoading() {
  return (
    <div className="flex items-center justify-center h-[300px] w-full">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  )
}

/**
 * ChartRenderer - Lazy-loaded wrapper around the recharts-based chart renderer
 */
export function ChartRenderer(props: {
  content: string
  className?: string
  chartType?: "line" | "bar" | "pie" | "doughnut" | "area" | "scatter" | "radar"
  chartData?: ChartDataPoint[]
}) {
  return (
    <Suspense fallback={<ChartLoading />}>
      <LazyChartRenderer {...props} />
    </Suspense>
  )
}

export function resolveArtifactRenderPlan(artifact: Artifact): ArtifactRenderPlan {
  const pluginRenderer = resolveRegisteredArtifactRenderer(artifact)
  if (pluginRenderer) {
    return {
      owner: "plugin",
      pluginRenderer,
    }
  }

  const adapter = getArtifactRuntimeAdapter(artifact.type)
  if (adapter.transport === "jupyter") {
    return { owner: "jupyter" }
  }

  if (adapter.transport === "renderer") {
    return {
      owner: "builtin",
      rendererType: adapter.rendererType,
    }
  }

  return { owner: "runtime" }
}

export function PluginArtifactRendererHost({
  artifact,
  renderer,
  className,
  fallback,
  onRuntimeStateChange,
}: {
  artifact: Artifact
  renderer: PluginArtifactRenderer
  className?: string
  fallback?: React.ReactNode
  onRuntimeStateChange?: (state: ArtifactRuntimeHealth, error?: string) => void
}) {
  const t = useTranslations("artifacts.pluginRenderer")
  const containerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<ReturnType<PluginArtifactRenderer["mount"]> | null>(null)
  const mountedArtifactRef = useRef<Artifact | null>(null)
  const latestArtifactRef = useRef(artifact)
  const translationsRef = useRef(t)
  const runtimeStateCallbackRef = useRef(onRuntimeStateChange)
  const renderContextKey = `${renderer.id}:${artifact.id}`
  const [renderState, setRenderState] = useState<{
    key: string
    status: "loading" | "ready" | "error"
    message?: string
  }>({ key: renderContextKey, status: "loading" })

  useEffect(() => {
    latestArtifactRef.current = artifact
    translationsRef.current = t
    runtimeStateCallbackRef.current = onRuntimeStateChange
  }, [artifact, onRuntimeStateChange, t])

  const reportReady = useCallback(() => {
    queueMicrotask(() => {
      setRenderState({ key: renderContextKey, status: "ready" })
    })
    runtimeStateCallbackRef.current?.("ready")
  }, [renderContextKey])

  const reportError = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : translationsRef.current("failed")
      queueMicrotask(() => {
        setRenderState({ key: renderContextKey, status: "error", message })
      })
      runtimeStateCallbackRef.current?.("error", message)
    },
    [renderContextKey]
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    try {
      container.replaceChildren()
      const artifactToMount = latestArtifactRef.current
      const handle = renderer.mount(artifactToMount, container)
      if (!handle || typeof handle.dispose !== "function") {
        throw new Error(translationsRef.current("missingDisposer"))
      }
      handleRef.current = handle
      mountedArtifactRef.current = artifactToMount
      reportReady()
    } catch (error) {
      reportError(error)
    }

    return () => {
      try {
        handleRef.current?.dispose()
      } catch (error) {
        runtimeStateCallbackRef.current?.(
          "error",
          error instanceof Error ? error.message : translationsRef.current("disposeFailed")
        )
      }
      handleRef.current = null
      mountedArtifactRef.current = null
      container.replaceChildren()
    }
  }, [renderContextKey, renderer, reportError, reportReady])

  useEffect(() => {
    if (mountedArtifactRef.current === artifact) return
    const container = containerRef.current
    const currentHandle = handleRef.current
    if (!container || !currentHandle) return
    try {
      if (currentHandle.update) {
        currentHandle.update(artifact)
      } else {
        currentHandle.dispose()
        handleRef.current = null
        container.replaceChildren()
        const nextHandle = renderer.mount(artifact, container)
        if (!nextHandle || typeof nextHandle.dispose !== "function") {
          throw new Error(translationsRef.current("missingDisposer"))
        }
        handleRef.current = nextHandle
      }
      mountedArtifactRef.current = artifact
      reportReady()
    } catch (error) {
      reportError(error)
    }
  }, [artifact, renderer, reportError, reportReady])

  const activeState =
    renderState.key === renderContextKey
      ? renderState
      : { key: renderContextKey, status: "loading" as const }

  if (activeState.status === "error") {
    return (
      <>
        <Alert variant="destructive" className="m-4">
          <AlertDescription>{activeState.message ?? t("failed")}</AlertDescription>
        </Alert>
        {fallback}
      </>
    )
  }

  return (
    <div
      className={cn("relative min-h-full w-full", className)}
      aria-busy={activeState.status === "loading"}
    >
      {activeState.status === "loading" && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/70">
          <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">{t("loading")}</span>
        </div>
      )}
      <div ref={containerRef} className="min-h-full w-full" />
    </div>
  )
}

/**
 * Generic Artifact Renderer - Routes to appropriate renderer based on type
 */
export function ArtifactRenderer({
  type,
  content,
  className,
  chartType,
  chartData,
  artifact,
}: {
  type: string
  content: string
  className?: string
  chartType?: "line" | "bar" | "pie" | "doughnut" | "area" | "scatter" | "radar"
  chartData?: ChartDataPoint[]
  artifact?: Artifact
}) {
  if (artifact) {
    const plan = resolveArtifactRenderPlan(artifact)
    if (plan.owner === "plugin" && plan.pluginRenderer) {
      return (
        <PluginArtifactRendererHost
          artifact={artifact}
          renderer={plan.pluginRenderer}
          className={className}
          fallback={
            <CodeBlock
              code={artifact.content}
              language={getShikiLanguage(artifact.language)}
              className={className}
            />
          }
        />
      )
    }
  }

  switch (type) {
    case "mermaid":
      return <MermaidBlock content={content} className={className} />
    case "chart":
      return (
        <ChartRenderer
          content={content}
          chartType={chartType}
          chartData={chartData}
          className={className}
        />
      )
    case "math":
      return <MathBlock content={content} className={className} />
    case "document":
      return <ChatMarkdownRenderer content={content} className={className} rhythm="document" />
    case "code":
      return (
        <CodeBlock
          code={content}
          language={getShikiLanguage(artifact?.language)}
          className={className}
        />
      )
    default:
      return (
        <CodeBlock
          code={content}
          language={getShikiLanguage(artifact?.language)}
          className={className}
        />
      )
  }
}
