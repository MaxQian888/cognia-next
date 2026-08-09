/**
 * `/limits` (alias `/subscription`) controller — the CLI analog of Claude Code's
 * `/usage` screen.
 *
 * Fetches the unified limits/usage for every configured subscription provider
 * (Anthropic 5h/7d windows via a ~10-token probe, Codex windows best-effort, and
 * credit balances for Kimi/OpenCodeGo/DeepSeek/…), runs the local session
 * analysis, and opens the themed `limits` bar panel. Never throws — a failed or
 * absent provider degrades to "no limit data" for that account.
 */
import { buildCliLimits, nodeAuthedGet } from "./limits-data"
import { analyzeSession } from "../format/usage-analysis"
import type { ResolvedConfig } from "../../config/schema"
import type { ProviderLimits } from "@/types/subscription"
import type { RateLimitSnapshot } from "../format/rate-limits"
import type { ToolStat, TuiAction } from "../state/types"

export interface LimitsDeps {
  dispatch: (action: TuiAction) => void
  config: ResolvedConfig
  /** Per-turn token history (drives the >150k-context analysis). */
  usageHistory?: number[]
  /** Per-tool call/error tallies (drives the subagent/top-tools analysis). */
  toolStats?: Record<string, ToolStat>
  /** Live API rate-limit reading from state (parsed from `usage_headers`). */
  rateLimits?: RateLimitSnapshot
  /** Clock for the reset countdowns; defaults to `Date.now`. */
  now?: () => number
  /** Limits-fetch seam (tests); defaults to the multi-provider CLI enumerator. */
  loadLimits?: (config: ResolvedConfig, now: number) => Promise<ProviderLimits[]>
}

// `buildCliLimits` is exhaustively guarded (every source.fetch is wrapped), so
// it resolves to `[]` rather than rejecting — no extra try/catch needed here.
function defaultLoad(config: ResolvedConfig, now: number): Promise<ProviderLimits[]> {
  return buildCliLimits({
    config,
    now,
    authedGet: nodeAuthedGet,
    activeProvider: config.provider,
  })
}

let nextLimitsRequestId = 0

export function runLimits(deps: LimitsDeps): void {
  const now = (deps.now ?? (() => Date.now()))()
  const requestId = ++nextLimitsRequestId
  const analysis = analyzeSession({
    usageHistory: deps.usageHistory,
    toolStats: deps.toolStats,
  })

  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "limits",
      snapshots: [],
      loading: true,
      requestId,
      analysis,
      now,
      rateLimits: deps.rateLimits,
      activeProvider: deps.config.provider,
    },
  })

  // Loading is deliberately detached from the runtime request. The panel is
  // interactive immediately and the shared runtime busy marker is released, so
  // a slow provider cannot turn subsequent command input into a queued steer.
  void (deps.loadLimits ?? defaultLoad)(deps.config, now)
    .then((snapshots) => deps.dispatch({ type: "LIMITS_LOADED", requestId, snapshots }))
    .catch((error: unknown) =>
      deps.dispatch({
        type: "LIMITS_LOADED",
        requestId,
        snapshots: [
          {
            provider: deps.config.provider,
            accountId: deps.config.provider,
            accountLabel: deps.config.provider,
            fetchedAt: now,
            meters: [],
            error: error instanceof Error ? error.message : String(error),
          },
        ],
      })
    )
}
