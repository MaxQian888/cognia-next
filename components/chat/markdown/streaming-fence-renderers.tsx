"use client"

/**
 * Streamdown custom renderers for the fences the finalised branch draws with
 * its own blocks (ADR-0218).
 *
 * Streamdown consults `plugins.renderers` before its built-in mermaid card, so
 * registering the app's `MermaidBlock` (and the inline `ChartBlock`) here makes
 * a streaming diagram or chart the very same component the finalised message
 * mounts: same frame, same palette, same
 * toolbar, and no re-layout when the turn seals. While a fence is still open
 * (`isIncomplete`) the block shows a sized placeholder in the same frame
 * instead of attempting to parse half a diagram on every token.
 */

import dynamic from "next/dynamic"
import { useTranslations } from "next-intl"
import { BarChart3Icon, Workflow } from "lucide-react"
import type { CustomRendererProps, PluginConfig } from "streamdown"
import { RichBlockFrame } from "@/components/chat/renderers/rich-block/rich-block-frame"
import { withRendererErrorBoundary } from "@/components/chat/renderers/renderer-error-boundary"
import { Skeleton } from "@/components/ui/skeleton"

const MermaidBlock = dynamic(
  () =>
    import("@/components/chat/renderers/mermaid-block").then((m) => ({ default: m.MermaidBlock })),
  { ssr: false, loading: () => <PendingMermaid /> }
)
const SafeMermaidBlock = withRendererErrorBoundary(MermaidBlock, "Mermaid")

// Recharts is a large chunk; the pending frame covers its load as well as an
// open fence, so neither moment shifts the layout.
const ChartBlock = dynamic(
  () => import("@/components/chat/renderers/chart-block").then((m) => ({ default: m.ChartBlock })),
  { ssr: false, loading: () => <PendingChart /> }
)
const SafeChartBlock = withRendererErrorBoundary(ChartBlock, "Chart")

function PendingChart() {
  const t = useTranslations("chat.renderers.chart")
  return (
    <RichBlockFrame
      kind="chart"
      icon={<BarChart3Icon />}
      label={t("label")}
      bodyClassName="p-(--rich-block-pad)"
      aria-busy
      data-fence-pending
    >
      <Skeleton className="h-56 w-full" />
    </RichBlockFrame>
  )
}

function PendingMermaid() {
  const t = useTranslations("chat.renderers.mermaid")
  return (
    <RichBlockFrame
      kind="mermaid"
      icon={<Workflow />}
      label={t("diagramTitle")}
      bodyClassName="p-(--rich-block-pad)"
      aria-busy
      data-fence-pending
    >
      <Skeleton className="h-32 w-full" />
    </RichBlockFrame>
  )
}

export function StreamingMermaidFence({ code, isIncomplete }: CustomRendererProps) {
  if (isIncomplete) return <PendingMermaid />
  return <SafeMermaidBlock content={code} />
}

export function StreamingChartFence({ code, isIncomplete }: CustomRendererProps) {
  if (isIncomplete) return <PendingChart />
  return <SafeChartBlock content={code} />
}

export interface StreamingFenceOptions {
  mermaid: boolean
  charts: boolean
}

const withRenderers = new WeakMap<PluginConfig, Map<string, PluginConfig>>()

/**
 * `plugins` plus the app's fence renderers, memoised per (plugin set, flags) so
 * `<Streamdown>` sees a stable `plugins` identity and never re-parses every
 * block because a new object arrived.
 */
export function withStreamingFenceRenderers(
  plugins: PluginConfig,
  options: StreamingFenceOptions
): PluginConfig {
  const key = `${options.mermaid ? "m" : "-"}${options.charts ? "c" : "-"}`
  let byFlags = withRenderers.get(plugins)
  if (!byFlags) {
    byFlags = new Map()
    withRenderers.set(plugins, byFlags)
  }
  const cached = byFlags.get(key)
  if (cached) return cached
  const renderers = [
    ...(options.mermaid ? [{ language: "mermaid", component: StreamingMermaidFence }] : []),
    ...(options.charts ? [{ language: "chart", component: StreamingChartFence }] : []),
  ]
  const next = renderers.length ? { ...plugins, renderers } : plugins
  byFlags.set(key, next)
  return next
}
