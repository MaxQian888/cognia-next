import { detectGraphics } from "../format/terminal-graphics"
import { supportsHyperlinks } from "../markdown/hyperlink"

export interface TuiRenderDiagnostics {
  engine: "virtualized" | "legacy"
  renderDurationMs: { latest: number; p95: number }
  resizeDurationMs: { latest: number; p95: number }
  blockCacheHitRate: number
  visibleBlocks: number
  totalBlocks: number
  unknownParts: number
  capabilities: {
    graphics: ReturnType<typeof detectGraphics>
    hyperlinks: boolean
    tty: boolean
    color: boolean
  }
}

const MAX_SAMPLES = 128
let renderSamples: number[] = []
let resizeSamples: number[] = []
let unknownParts = 0
let cache = { hitRate: 0, visible: 0, total: 0 }

function push(samples: number[], value: number): number[] {
  const next = [...samples, Math.max(0, value)]
  return next.length > MAX_SAMPLES ? next.slice(-MAX_SAMPLES) : next
}

function metric(samples: number[]): { latest: number; p95: number } {
  if (samples.length === 0) return { latest: 0, p95: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    latest: samples[samples.length - 1],
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
  }
}

export function recordRenderDuration(durationMs: number): void {
  renderSamples = push(renderSamples, durationMs)
}

export function recordResizeDuration(durationMs: number): void {
  resizeSamples = push(resizeSamples, durationMs)
}

export function recordUnknownPart(): void {
  unknownParts += 1
}

export function recordBlockCacheStats(
  stats: { hitRate: number; hits?: number; misses?: number; size?: number },
  visibleBlocks: number,
  totalBlocks: number
): void {
  cache = { hitRate: stats.hitRate, visible: visibleBlocks, total: totalBlocks }
}

export function snapshotRenderDiagnostics(
  env: Record<string, string | undefined> = process.env
): TuiRenderDiagnostics {
  return {
    engine: env.COGNIA_TUI_RENDERER === "legacy" ? "legacy" : "virtualized",
    renderDurationMs: metric(renderSamples),
    resizeDurationMs: metric(resizeSamples),
    blockCacheHitRate: cache.hitRate,
    visibleBlocks: cache.visible,
    totalBlocks: cache.total,
    unknownParts,
    capabilities: {
      graphics: detectGraphics(env),
      hyperlinks: supportsHyperlinks(env),
      tty: Boolean(process.stdout.isTTY),
      color: env.NO_COLOR === undefined && env.TERM !== "dumb",
    },
  }
}

export function resetRenderDiagnostics(): void {
  renderSamples = []
  resizeSamples = []
  unknownParts = 0
  cache = { hitRate: 0, visible: 0, total: 0 }
}
