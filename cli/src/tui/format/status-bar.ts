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

import {
  DEFAULT_STATUS_SEGMENTS,
  type ResolvedConfig,
  type StatusSegment,
  type StatusTheme,
} from "../../config/schema"
import {
  cacheHitRatio,
  contextPercent,
  contextTokens,
  formatCost,
  formatTokens,
  shortenCwd,
} from "./usage"
import type { SessionTotals, UsageInfo } from "../state/types"

/** One rendered footer segment. */
export interface StatusSegmentView {
  id: StatusSegment
  text: string
  color?: string
  dim?: boolean
}

/** Per-segment colors for the "vivid" theme. */
const VIVID: Record<StatusSegment, string> = {
  model: "cyan",
  provider: "green",
  mode: "yellow",
  tokens: "blue",
  ctx: "magenta",
  cache: "cyan",
  cost: "green",
  cwd: "gray",
  git: "yellow",
  thinking: "magenta",
}

/** Resolve a segment's color + dim flag for the active theme. */
function styleFor(theme: StatusTheme, id: StatusSegment): { color?: string; dim?: boolean } {
  switch (theme) {
    case "mono":
      return {}
    case "dim":
      return { color: "gray", dim: true }
    case "vivid":
      return { color: VIVID[id] }
    case "default":
    default:
      // Matches the pre-customization footer: model in cyan, everything else gray.
      return { color: id === "model" ? "cyan" : "gray" }
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
  }
): string | null {
  const { config, usage, totals } = ctx
  switch (id) {
    case "model":
      return config.model ?? "default"
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
      return `${contextPercent(usage, config.model, ctx.contextWindow)}% ctx`
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
}): StatusSegmentView[] {
  const theme = ctx.config.statusBar?.theme ?? "default"
  const out: StatusSegmentView[] = []
  for (const id of resolveSegments(ctx.config)) {
    const text = segmentText(id, ctx)
    if (text === null) continue
    const style = styleFor(theme, id)
    // Force the bypass-mode segment to a warning colour regardless of theme.
    if (id === "mode" && ctx.config.permissionMode === "bypassPermissions") {
      out.push({ id, text, color: "yellow", dim: false })
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
