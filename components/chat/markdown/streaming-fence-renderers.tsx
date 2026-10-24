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
 *
 * An ```a2ui fence is the exception to "placeholder until closed": its preview
 * parses the structurally complete prefix (`a2ui-streaming-fence.tsx`), so an
 * interface assembles while it streams instead of scrolling past as JSON.
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

// The A2UI renderer and its catalog are a large chunk; the pending frame
// covers the load the same way the preview covers a fence with no component yet.
const StreamingA2UIPreview = dynamic(
  () =>
    import("@/components/chat/renderers/a2ui-streaming-fence").then((m) => ({
      default: m.A2UIStreamingPreview,
    })),
  { ssr: false, loading: () => <PendingA2UI /> }
)
const SafeStreamingA2UIPreview = withRendererErrorBoundary(StreamingA2UIPreview, "A2UI")

function PendingA2UI() {
  const t = useTranslations("chat.renderers.a2ui")
  return (
    <div
      role="status"
      aria-busy
      aria-label={t("generating")}
      data-fence-pending
      className="my-2 space-y-2 rounded-lg border bg-card p-3"
    >
      <span className="text-muted-foreground text-xs">{t("generating")}</span>
      <Skeleton className="h-16 w-full" />
    </div>
  )
}

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

export function StreamingA2UIFence(props: CustomRendererProps) {
  return <SafeStreamingA2UIPreview {...props} />
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
  // A2UI has no display toggle: the finalised branch always draws the fence.
  const renderers = [
    ...(options.mermaid ? [{ language: "mermaid", component: StreamingMermaidFence }] : []),
    ...(options.charts ? [{ language: "chart", component: StreamingChartFence }] : []),
    { language: "a2ui", component: StreamingA2UIFence },
  ]
  const next = { ...plugins, renderers }
  byFlags.set(key, next)
  return next
}
