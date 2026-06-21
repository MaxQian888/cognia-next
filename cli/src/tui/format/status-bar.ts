/**
 * Pure view-model for the customizable status footer. Turns the resolved config
 * (`statusBar.segments` + `statusBar.theme`) and the latest usage into an ordered
 * list of colored segments the {@link Footer} renders. Reuses the field
 * formatters in `format/usage.ts` so the numbers match the rest of the CLI.
 *
 * Also exposes the small progress/gauge string builders used by the activity
 * pill and the `ctx` segment / `/context` report.
 */
import fs from "node:fs"
import path from "node:path"

import { resolveActiveModel } from "../../config/active-model"
import {
  DEFAULT_STATUS_SEGMENTS,
  type ResolvedConfig,
  type StatusSegment,
  type StatusTheme,
} from "../../config/schema"
import { getBuiltinTheme } from "../theme/builtins"
import type { ThemePalette } from "../theme/palette"
import {
  cacheHitRatio,
  contextPercent,
  contextTokens,
  formatCost,
  formatTokens,
  shortenCwd,
} from "./usage"
import { tightestRemainingPct, type RateLimitSnapshot } from "./rate-limits"
import type { SessionTotals, UsageInfo } from "../state/types"

/** One rendered footer segment. */
export interface StatusSegmentView {
  id: StatusSegment
  text: string
  color?: string
  dim?: boolean
}

/** Per-segment palette token for the "vivid" footer theme. Under the classic
 * palette these resolve to the historic vivid colours (cyan/green/yellow/…). */
const SEGMENT_TOKEN: Record<StatusSegment, keyof ThemePalette> = {
  model: "accent",
  provider: "success",
  mode: "warning",
  tokens: "info",
  ctx: "secondary",
  cache: "accent",
  cost: "success",
  cwd: "muted",
  git: "warning",
  thinking: "secondary",
  ratelimit: "warning",
}

/** Resolve a segment's color + dim flag for the active footer theme + palette. */
function styleFor(
  theme: StatusTheme,
  id: StatusSegment,
  palette: ThemePalette
): { color?: string; dim?: boolean } {
  switch (theme) {
    case "mono":
      return {}
    case "dim":
      return { color: palette.muted, dim: true }
    case "vivid":
      return { color: palette[SEGMENT_TOKEN[id]] as string }
    case "default":
    default:
      // Matches the pre-customization footer: model in the accent, rest muted.
      return { color: id === "model" ? palette.accent : palette.muted }
  }
}

/**
 * Read the current git branch from `<cwd>/.git/HEAD` without spawning a process.
 * Returns null when the folder isn't a git repo (or HEAD is detached/unreadable).
 * Injectable for tests.
 */
export function readGitBranch(
  cwd: string,
  readText: (p: string) => string = (p) => fs.readFileSync(p, "utf8")
): string | null {
  try {
    const head = readText(path.join(cwd, ".git", "HEAD")).trim()
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    if (m) return m[1]
    // Detached HEAD → short commit sha.
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 7)
    return null
  } catch {
    return null
  }
}

/** Render the text for one segment, or null when it has nothing to show. */
function segmentText(
  id: StatusSegment,
  ctx: {
    config: ResolvedConfig
    usage?: UsageInfo
    totals?: SessionTotals
    git?: string | null
    contextWindow?: number
    rateLimits?: RateLimitSnapshot
  }
): string | null {
  const { config, usage, totals } = ctx
  switch (id) {
    case "model":
      // The model actually dispatched is the active provider's resolved model —
      // NOT the legacy top-level `config.model`, which can hold another
      // provider's leftover id and show e.g. a DeepSeek model on Anthropic.
      return resolveActiveModel(config) ?? "default"
    case "provider":
      return config.provider
    case "mode":
      // bypassPermissions disarms every tool-approval gate — surface a loud,
      // persistent warning so it can't run silently for a whole session.
      return config.permissionMode === "bypassPermissions"
        ? `⚠ ${config.permissionMode}`
        : config.permissionMode
    case "tokens": {
      const total = totals
        ? totals.inputTokens + totals.outputTokens
        : (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
      return `${formatTokens(total)} tok`
    }
    case "ctx":
      return `${contextPercent(usage, resolveActiveModel(config), ctx.contextWindow)}% ctx`
    case "cache":
      // Prefix-cache hit rate. Hidden until a turn reports prompt tokens — a
      // "0%" before the first turn would just be noise in the footer.
      return usage && contextTokens(usage) > 0
        ? `⚡ ${Math.round(cacheHitRatio(usage) * 100)}%`
        : null
    case "cost":
      return formatCost(totals ? totals.costUsd : usage?.totalCostUsd)
    case "cwd":
      return shortenCwd(config.cwd)
    case "git":
      return ctx.git ? `⎇ ${ctx.git}` : null
    case "thinking":
      // Only shown once a level is set, and never for the "off" default —
      // an empty thinking segment would just be noise in the footer.
      return config.thinkingLevel && config.thinkingLevel !== "off"
        ? `🧠 ${config.thinkingLevel}`
        : null
    case "ratelimit": {
      // Tightest remaining headroom across the live API quota windows. Hidden
      // until a response lands — a "100%" before the first call would be noise.
      if (!ctx.rateLimits) return null
      const headroom = tightestRemainingPct(ctx.rateLimits)
      return headroom == null ? null : `🚦 ${headroom}%`
    }
  }
}

/** Resolve the ordered, validated segment list (falls back to the default). */
export function resolveSegments(config: ResolvedConfig): StatusSegment[] {
  const segs = config.statusBar?.segments
  return segs && segs.length > 0 ? segs : DEFAULT_STATUS_SEGMENTS
}

/** Build the ordered footer segments for the active config + usage. */
export function buildStatusBar(ctx: {
  config: ResolvedConfig
  usage?: UsageInfo
  totals?: SessionTotals
  git?: string | null
  /** Per-model context window (from the catalog) for the `ctx` segment. */
  contextWindow?: number
  /** Live API rate-limit reading for the `ratelimit` segment. */
  rateLimits?: RateLimitSnapshot
  /** Active colour palette. Defaults to `classic` so the footer keeps its
   * historic colours when no theme is supplied (e.g. in unit tests). */
  palette?: ThemePalette
}): StatusSegmentView[] {
  const palette = ctx.palette ?? getBuiltinTheme("classic")
  const theme = ctx.config.statusBar?.theme ?? "default"
  const out: StatusSegmentView[] = []
  for (const id of resolveSegments(ctx.config)) {
    const text = segmentText(id, ctx)
    if (text === null) continue
    const style = styleFor(theme, id, palette)
    // Force the bypass-mode segment to a warning colour regardless of theme.
    if (id === "mode" && ctx.config.permissionMode === "bypassPermissions") {
      out.push({ id, text, color: palette.warning, dim: false })
      continue
    }
    out.push({ id, text, ...style })
  }
  return out
}

/** A determinate progress bar: `progressBar(3, 5)` → "▰▰▰▱▱". */
export function progressBar(done: number, total: number, width = 5): string {
  if (total <= 0) return "▱".repeat(width)
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)))
  return "▰".repeat(filled) + "▱".repeat(width - filled)
}

/** A bracketed context gauge: `contextGauge(42)` → "[██▱▱▱]" + "42%". */
export function contextGauge(pct: number, width = 6): string {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)))
  const filled = Math.round((clamped / 100) * width)
  return `[${"█".repeat(filled)}${"▱".repeat(width - filled)}] ${clamped}%`
}
