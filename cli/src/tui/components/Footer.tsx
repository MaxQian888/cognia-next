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

/** Keep every footer suffix inside the same physical terminal row. */
export function fitFooterSuffixes(
  columns: number,
  firstSegmentWidth: number,
  planTitle: string | undefined,
  showHint: boolean
): { planText: string; hintText: string; reservedWidth: number } {
  const roomAfterIdentity = Math.max(0, columns - firstSegmentWidth - 2)
  const hintText = showHint && stringWidth(HINT_TEXT) <= roomAfterIdentity ? HINT_TEXT : ""
  const planPrefix = " · 📋 "
  const planRoom = Math.max(0, roomAfterIdentity - stringWidth(hintText))
  let planText = ""
  if (planTitle && planRoom > stringWidth(planPrefix) + 1) {
    const titleRoom = planRoom - stringWidth(planPrefix)
    const fittedTitle = truncateToWidth(planTitle, titleRoom)
    planText = planPrefix + fittedTitle
  }
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
  const suffixes = React.useMemo(
    () =>
      fitFooterSuffixes(
        cols,
        allSegments[0] ? stringWidth(allSegments[0].text) : 0,
        planTitle,
        !busy && showHint && config.statusBar?.showHints !== false
      ),
    [cols, allSegments, planTitle, busy, showHint, config.statusBar?.showHints]
  )
  const { segments, truncated } = React.useMemo(
    () => fitStatusSegments(allSegments, Math.max(0, cols - suffixes.reservedWidth)),
    [allSegments, cols, suffixes.reservedWidth]
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
