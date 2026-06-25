"use client"

/**
 * Artifact Renderers - Specialized renderers for different artifact types.
 * Adapted from Cognia: re-exports cognia-next's chat renderers (Mermaid /
 * Math / Code / Markdown), lazy-loads ChartRenderer, and supports the
 * renderer-registry plugin extension surface.
 */

import { Suspense, lazy, useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
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
  const containerRef = useRef<HTMLDivElement>(null)
  const renderContextKey = `${renderer.id}:${artifact.id}`
  const [renderError, setRenderError] = useState<{ key: string; message: string } | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    try {
      const element = renderer.render(artifact)
      onRuntimeStateChange?.("ready")
      // Plugin renderer returns a React element; for the registry contract we
      // surface a minimal mount via setHTML — plugins that need richer
      // lifecycle should use the React renderer directly.
      if (element) {
        container.innerHTML = ""
        const wrapper = document.createElement("div")
        container.appendChild(wrapper)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to render plugin artifact"
      queueMicrotask(() => {
        setRenderError({ key: renderContextKey, message })
      })
      onRuntimeStateChange?.("error", message)
    }

    return () => {
      if (container) {
        container.innerHTML = ""
      }
    }
  }, [artifact, onRuntimeStateChange, renderContextKey, renderer])

  const activeRenderError = renderError?.key === renderContextKey ? renderError.message : null

  if (activeRenderError) {
    return (
      <>
        <Alert variant="destructive" className="m-4">
          <AlertDescription>{activeRenderError}</AlertDescription>
        </Alert>
        {fallback}
      </>
    )
  }

  return <div ref={containerRef} className={cn("min-h-full w-full", className)} />
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
      return <ChatMarkdownRenderer content={content} className={className} />
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
