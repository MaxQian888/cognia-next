/**
 * `/limits` controller — the CLI analog of Claude Code's `/usage` screen.
 *
 * Probes the Anthropic unified rate-limit headers (5h session + 7d week windows)
 * via the shared `probeOnce`, runs the local session analysis, and opens the
 * result in the existing scrollable `document` overlay (markdown). The probe is
 * Anthropic-subscription-only and costs ~10 tokens; when no `anthropic` token is
 * configured the report still renders the local analysis with an explanatory
 * note. Never throws — a failed/absent probe degrades to "no subscription data".
 */
import type { AnthropicCredentialData, UsageSnapshot } from "@/types/subscription"
import { probeOnce } from "@/lib/subscription/anthropic/usage-probe"

import { analyzeSession } from "../format/usage-analysis"
import { buildLimitsReport } from "../format/limits"
import type { ResolvedConfig } from "../../config/schema"
import type { ToolStat, TuiAction } from "../state/types"

/** Probe the live Anthropic usage; returns null on any failure. */
async function defaultProbe(token: string): Promise<UsageSnapshot | null> {
  // `probeOnce` only reads `accessToken`; the rest of the credential shape is
  // irrelevant to a single header probe.
  const outcome = await probeOnce({ accessToken: token } as AnthropicCredentialData)
  return outcome.ok ? outcome.snapshot : null
}

export interface LimitsDeps {
  dispatch: (action: TuiAction) => void
  config: ResolvedConfig
  /** Per-turn token history (drives the >150k-context analysis). */
  usageHistory?: number[]
  /** Per-tool call/error tallies (drives the subagent/top-tools analysis). */
  toolStats?: Record<string, ToolStat>
  /** Clock for the reset countdown; defaults to `Date.now`. */
  now?: () => number
  /** Probe seam (tests). */
  probe?: (token: string) => Promise<UsageSnapshot | null>
  /** Explicit Anthropic token (tests); defaults to the configured one. */
  anthropicToken?: string
}

export async function runLimits(deps: LimitsDeps): Promise<void> {
  const now = (deps.now ?? (() => Date.now()))()
  const analysis = analyzeSession({
    usageHistory: deps.usageHistory,
    toolStats: deps.toolStats,
  })

  const token = deps.anthropicToken ?? deps.config.providers["anthropic"]?.authToken
  let snapshot: UsageSnapshot | null = null
  if (token) {
    try {
      snapshot = await (deps.probe ?? defaultProbe)(token)
    } catch {
      snapshot = null
    }
  }

  const body = buildLimitsReport(snapshot, analysis, now)
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: { kind: "document", title: "Usage & limits", body, format: "markdown" },
  })
}
