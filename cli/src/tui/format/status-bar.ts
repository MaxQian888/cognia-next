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
import { stringWidth } from "../markdown/width"
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
import { isBuiltinBackend } from "../runtime/backend-capabilities"
import { backendSegmentText } from "../runtime/backend-identity"
import type { SessionTotals, UsageInfo } from "../state/types"
import { permissionModeMeta } from "../state/permission-mode-meta"

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
  backend: "secondary",
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

/**
 * True when an external agent is answering and nothing has told us its context
 * window — the case where a `% ctx` gauge would be pure fabrication.
 */
function externalWithoutKnownWindow(config: ResolvedConfig, contextWindow?: number): boolean {
  return !isBuiltinBackend(config.agentBackend) && !(contextWindow && contextWindow > 0)
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
      // A danger-tier mode (bypassPermissions) disarms every tool-approval gate —
      // surface a loud, persistent warning so it can't run silently for a whole
      // session. Sourced from the shared risk model so a future danger mode is
      // covered without editing this branch.
      return permissionModeMeta(config.permissionMode).risk === "danger"
        ? `⚠ ${config.permissionMode}`
        : config.permissionMode
    case "tokens": {
      const total = totals
        ? totals.inputTokens + totals.outputTokens
        : (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
      return `${formatTokens(total)} tok`
    }
    case "backend":
      return backendSegmentText(config)
    case "ctx":
      // The window comes from the built-in provider's catalog, which says
      // nothing about an external agent's model — a percentage derived from it
      // would be invented. Show nothing instead.
      return externalWithoutKnownWindow(config, ctx.contextWindow)
        ? null
        : `${contextPercent(usage, resolveActiveModel(config), ctx.contextWindow)}% ctx`
    case "cache":
      // Prefix-cache hit rate. Hidden until a turn reports prompt tokens — a
      // "0%" before the first turn would just be noise in the footer.
      return usage && contextTokens(usage) > 0
        ? `⚡ ${Math.round(cacheHitRatio(usage) * 100)}%`
        : null
    case "cost":
      // Same reason as `ctx`: the cost would be this session's tokens priced
      // with the built-in model's rate card, which is not what ran.
      return isBuiltinBackend(config.agentBackend)
        ? formatCost(totals ? totals.costUsd : usage?.totalCostUsd)
        : null
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
    // Force a danger-tier mode segment (bypassPermissions) to a warning colour
    // regardless of theme.
    if (id === "mode" && permissionModeMeta(ctx.config.permissionMode).risk === "danger") {
      out.push({ id, text, color: palette.warning, dim: false })
      continue
    }
    out.push({ id, text, ...style })
  }
  return out
}

/**
 * Drop-priority for each segment when the persistent status line can't fit the
 * terminal width: HIGHER survives longer. The identity segments the user reads
 * most (model / mode / context / tokens) are kept; cost and git are sacrificed
 * first; everything else sits in a middle band and keeps its declared order on a
 * tie. Mirrors the plan's `model > mode > ctx > tokens > … > git > cost`.
 */
const SEGMENT_KEEP_PRIORITY: Record<StatusSegment, number> = {
  model: 100,
  // Ranks with the model: on a narrow terminal, WHICH agent is answering is the
  // last thing that should be dropped.
  backend: 95,
  mode: 90,
  ctx: 80,
  tokens: 70,
  provider: 50,
  cwd: 50,
  cache: 50,
  thinking: 50,
  ratelimit: 50,
  git: 40,
  cost: 30,
}

/** The ` · ` separator the Footer renders between segments. */
const SEGMENT_SEP = " · "
const SEP_WIDTH = stringWidth(SEGMENT_SEP)
/** Display width reserved for the trailing ` …` truncation marker. */
const ELLIPSIS_WIDTH = 2

/** Total display width of segments joined by ` · ` (CJK-aware). */
function joinedWidth(segments: StatusSegmentView[]): number {
  if (segments.length === 0) return 0
  let w = 0
  for (const s of segments) w += stringWidth(s.text)
  return w + SEP_WIDTH * (segments.length - 1)
}

/** Result of fitting the status line to a terminal width. */
export interface FittedStatusBar {
  /** The segments that survived, in their original order. */
  segments: StatusSegmentView[]
  /** Whether any segment was dropped (the Footer shows a trailing ` …`). */
  truncated: boolean
}

/**
 * Fit the persistent status segments into `columns` display columns by dropping
 * the lowest-{@link SEGMENT_KEEP_PRIORITY} segments (rightmost first on a tie)
 * until the rest fit with room for a ` …` marker. Pure — the {@link Footer}
 * renders the survivors plus a trailing ellipsis when `truncated`. Never drops
 * the single most-important segment; `columns <= 0` yields nothing.
 */
export function fitStatusSegments(segments: StatusSegmentView[], columns: number): FittedStatusBar {
  if (columns <= 0) return { segments: [], truncated: false }
  if (segments.length === 0 || joinedWidth(segments) <= columns) {
    return { segments, truncated: false }
  }
  const kept = segments.map((s, i) => ({ s, i }))
  let truncated = false
  while (kept.length > 1 && joinedWidth(kept.map((k) => k.s)) + ELLIPSIS_WIDTH > columns) {
    let dropAt = 0
    for (let j = 1; j < kept.length; j++) {
      const pj = SEGMENT_KEEP_PRIORITY[kept[j].s.id] ?? 50
      const pd = SEGMENT_KEEP_PRIORITY[kept[dropAt].s.id] ?? 50
      // Lowest priority drops first; on a tie the rightmost (greater index).
      if (pj < pd || (pj === pd && kept[j].i > kept[dropAt].i)) dropAt = j
    }
    kept.splice(dropAt, 1)
    truncated = true
  }
  return { segments: kept.map((k) => k.s), truncated }
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
