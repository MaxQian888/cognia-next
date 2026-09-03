/**
 * The persistent status line, pinned below the composer: a customizable, ordered
 * set of stable identity segments (model · provider · mode · tokens · ctx · cost ·
 * cwd · git) in one of four colour themes, plus a `📋` plan chip (plans persist
 * across turns) and the idle discoverability hint. Segment selection + theme come
 * from `config.statusBar`; the view-model is the pure `buildStatusBar`, fitted to
 * the terminal width by `fitStatusSegments` so a narrow terminal drops the
 * lowest-priority segments instead of wrapping raggedly.
 *
 * Everything *transient* — the spinner, elapsed timer, live tool detail, run-state
 * chips, and the steer queue — now lives in {@link BottomStatus} ABOVE the
 * composer, so this line stays a steady identity readout.
 */
import React from "react"
import { Box, Text, type DOMElement } from "ink"

import {
  buildStatusBar,
  fitStatusSegments,
  fittedStatusWidth,
  readGitBranch,
  resolveSegments,
  type StatusSegmentView,
} from "../format/status-bar"
import { useTheme } from "../theme/context"
import { stringWidth, truncateToWidth } from "../markdown/width"
import type { RateLimitSnapshot } from "../format/rate-limits"
import type { BackendCapabilities } from "../runtime/backend-capabilities"
import type { ResolvedConfig } from "../../config/schema"
import type { SessionTotals, TurnStatus, UsageInfo } from "../state/types"

const HINT_TEXT = " · ⚙ /settings · ▸ /inspect"

const PLAN_PREFIX = " · 📋 "

/** The most of the row a plan chip may claim before the identity segments are
 * fitted. A plan title is session content worth a glance, but it is not worth
 * more than a third of the status line. */
const PLAN_MAX_SHARE = 1 / 3

/**
 * Columns to hold back for the plan chip before the status segments are fitted.
 * Bounded, so a long plan title can never push model / mode / context off the
 * row: whatever the chip does not need goes straight back to the segments.
 */
export function planReserve(columns: number, planTitle: string | undefined): number {
  if (!planTitle) return 0
  const wanted = stringWidth(PLAN_PREFIX) + stringWidth(planTitle)
  const cap = Math.floor(Math.max(0, columns) * PLAN_MAX_SHARE)
  return Math.min(wanted, cap)
}

/**
 * Fit the footer's suffixes into the columns the identity segments left over.
 *
 * `room` is what remains AFTER the status row has been fitted (which itself ran
 * against a width already reduced by {@link planReserve}). Both suffixes used to
 * be reserved up front off the FIRST segment's width alone: on a 92-column
 * terminal that handed 54 columns to a plan title and a constant hint, and
 * truncated model / context / tokens / cwd with a "…" to pay for them.
 *
 * Within the leftover the plan chip still wins. It names what this session
 * proposed, where the hint is the same sentence every time.
 */
export function fitFooterSuffixes(
  room: number,
  planTitle: string | undefined,
  showHint: boolean
): { planText: string; hintText: string; reservedWidth: number } {
  const available = Math.max(0, room)
  let planText = ""
  if (planTitle && available > stringWidth(PLAN_PREFIX) + 1) {
    planText = PLAN_PREFIX + truncateToWidth(planTitle, available - stringWidth(PLAN_PREFIX))
  }
  const afterPlan = available - stringWidth(planText)
  const hintText = showHint && stringWidth(HINT_TEXT) <= afterPlan ? HINT_TEXT : ""
  return {
    planText,
    hintText,
    reservedWidth: stringWidth(planText) + stringWidth(hintText),
  }
}

function FooterImpl({
  config,
  usage,
  totals,
  turnStatus,
  gitBranch,
  contextWindow,
  rateLimits,
  planTitle,
  columns,
  capabilities,
  rowRef,
  segmentsRef,
  showHint = true,
}: {
  config: ResolvedConfig
  usage?: UsageInfo
  totals?: SessionTotals
  turnStatus: TurnStatus
  /** Pre-resolved git branch; when omitted it is read from `<cwd>/.git/HEAD`
   * only if the `git` segment is enabled. Injected by tests. */
  gitBranch?: string | null
  /** Per-model context window (from the catalog) for the `ctx` segment. */
  contextWindow?: number
  /** Live API rate-limit reading for the `ratelimit` segment. */
  rateLimits?: RateLimitSnapshot
  /** Title of the session's latest captured plan; shown as a `📋` chip so the
   * plan stays visible at a glance (open it full-screen with `/plan`). */
  planTitle?: string
  /** Terminal width for priority truncation; defaults to the live stdout width. */
  columns?: number
  /** Connected backend's capabilities — lets the `mode` segment say when the
   * agent is running under a mode other than the one that was picked. */
  capabilities?: BackendCapabilities
  /** Ref to the status-line Box so App can hit-test a click against its row. */
  rowRef?: React.Ref<DOMElement>
  /** Receives the exact fitted segments App needs to map a click column to a
   * segment id (single source of truth — no recompute on the App side). */
  segmentsRef?: React.MutableRefObject<StatusSegmentView[] | null>
  showHint?: boolean
}) {
  const theme = useTheme()
  const cols = columns ?? 80
  const busy = turnStatus !== "idle"
  const segmentsConfig = React.useMemo(() => resolveSegments(config), [config])
  const wantsGit = segmentsConfig.includes("git")
  const git = React.useMemo(
    () => (gitBranch !== undefined ? gitBranch : wantsGit ? readGitBranch(config.cwd) : null),
    [gitBranch, wantsGit, config.cwd]
  )
  const allSegments = React.useMemo(
    () =>
      buildStatusBar({
        config,
        usage,
        totals,
        git,
        contextWindow,
        rateLimits,
        capabilities,
        palette: theme,
      }),
    [config, usage, totals, git, contextWindow, rateLimits, capabilities, theme]
  )
  // Identity first, suffixes out of what is left. The only width held back is a
  // bounded slice for the plan chip; the idle hint is pure leftover, so it can
  // never evict the status this row exists to show.
  const fitted = React.useMemo(
    () => fitStatusSegments(allSegments, cols - planReserve(cols, planTitle)),
    [allSegments, cols, planTitle]
  )
  const { segments, truncated } = fitted
  const suffixes = React.useMemo(
    () =>
      fitFooterSuffixes(
        cols - fittedStatusWidth(fitted),
        planTitle,
        !busy && showHint && config.statusBar?.showHints !== false
      ),
    [cols, fitted, planTitle, busy, showHint, config.statusBar?.showHints]
  )
  // Cache the rendered segments so App's footer click hit-test maps a column to
  // the EXACT segment shown. Written in an effect (not during render) so it never
  // trips the refs-during-render rule.
  React.useEffect(() => {
    if (segmentsRef) segmentsRef.current = segments
  }, [segmentsRef, segments])

  return (
    <Box flexShrink={0} ref={rowRef}>
      {segments.map((seg, i) => (
        <Text key={seg.id} color={seg.color} dimColor={seg.dim}>
          {i > 0 ? " · " : ""}
          {seg.text}
        </Text>
      ))}
      {truncated ? (
        <Text color={theme.muted} dimColor>
          {" …"}
        </Text>
      ) : null}
      {suffixes.planText ? (
        <Text color={theme.accent} dimColor>
          {suffixes.planText}
        </Text>
      ) : null}
      {/* Persistent discoverability hint — only when idle so it never competes
          with the transient working indicator above the composer. */}
      {suffixes.hintText ? (
        <Text color={theme.muted} dimColor>
          {suffixes.hintText}
        </Text>
      ) : null}
    </Box>
  )
}

export const Footer = React.memo(FooterImpl)
