/**
 * Subscription limits/usage panel (`/limits`, alias `/subscription`). Read-only —
 * any key closes it. Renders Claude-Code-style utilization bars across every
 * configured subscription account (active provider first): a label, a full-width
 * bar colored by severity, a right-aligned "% used" / "credit left" figure, and a
 * reset countdown. Below the bars it shows the local session analysis (scoped to
 * this machine, not the subscription as a whole).
 *
 * All numbers come from pure helpers (`format/limits`), so this component is just
 * layout + theme color.
 */
import React from "react"
import { Box, Text, useInput } from "ink"

import {
  meterColor,
  meterFill,
  meterLabel,
  meterResetText,
  meterRightLabel,
  noDataHint,
} from "../../format/limits"
import {
  rateLimitColor,
  rateLimitResetText,
  rateLimitRightLabel,
  type RateLimitMeter,
  type RateLimitSnapshot,
} from "../../format/rate-limits"
import { formatTokens } from "../../format/usage"
import { useTheme } from "../../theme/context"
import type { SessionAnalysis } from "../../format/usage-analysis"
import type { LimitsMeter, ProviderLimits } from "@/types/subscription"

/** Bar width in columns. */
const BAR_WIDTH = 32

function MeterRow({ meter, now }: { meter: LimitsMeter; now: number }) {
  const theme = useTheme()
  // A pure credit balance has no computable percentage, so a full-width bar is
  // meaningless (it always renders empty/gray). Show just the figure, colored by
  // severity — so a depleted/negative balance reads red instead of a stray bar.
  if (meter.kind === "balance" && meter.usedPct == null) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{meterLabel(meter)}</Text>
        <Text color={theme[meterColor(meter.status)]}>{meterRightLabel(meter)}</Text>
      </Box>
    )
  }
  const filled = meterFill(meter.usedPct, BAR_WIDTH)
  const reset = meter.kind === "window" ? meterResetText(meter, now) : null
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{meterLabel(meter)}</Text>
      <Text>
        <Text color={theme[meterColor(meter.status)]}>{"█".repeat(filled)}</Text>
        <Text color={theme.muted}>{"█".repeat(BAR_WIDTH - filled)}</Text>
        <Text>{"  "}</Text>
        <Text color={theme.muted}>{meterRightLabel(meter)}</Text>
      </Text>
      {reset && (
        <Text color={theme.muted} dimColor>
          {reset}
        </Text>
      )}
    </Box>
  )
}

function RateLimitRow({ meter, now }: { meter: RateLimitMeter; now: number }) {
  const theme = useTheme()
  const filled = meterFill(meter.usedPct, BAR_WIDTH)
  const reset = rateLimitResetText(meter.resetAt, now)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{meter.label}</Text>
      <Text>
        <Text color={theme[rateLimitColor(meter.usedPct)]}>{"█".repeat(filled)}</Text>
        <Text color={theme.muted}>{"█".repeat(BAR_WIDTH - filled)}</Text>
        <Text>{"  "}</Text>
        <Text color={theme.muted}>{rateLimitRightLabel(meter)}</Text>
      </Text>
      {reset && (
        <Text color={theme.muted} dimColor>
          {reset}
        </Text>
      )}
    </Box>
  )
}

function RateLimitBlock({ snapshot, now }: { snapshot: RateLimitSnapshot; now: number }) {
  const theme = useTheme()
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.accent}>API rate limits (live)</Text>
      {snapshot.meters.map((m) => (
        <RateLimitRow key={m.kind} meter={m} now={now} />
      ))}
    </Box>
  )
}

function ProviderBlock({
  snapshot,
  now,
  active,
}: {
  snapshot: ProviderLimits
  now: number
  /** Whether this block is the active provider — badged `● active` + bold. */
  active?: boolean
}) {
  const theme = useTheme()
  const header =
    snapshot.accountLabel && snapshot.accountLabel !== snapshot.provider
      ? `${snapshot.provider} · ${snapshot.accountLabel}`
      : snapshot.provider
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.accent} bold={active}>
        {header}
        {active ? <Text color={theme.success}>{"  ● active"}</Text> : null}
      </Text>
      {snapshot.error ? (
        <Text color={theme.danger}>{snapshot.error}</Text>
      ) : snapshot.meters.length > 0 ? (
        snapshot.meters.map((m) => <MeterRow key={m.id} meter={m} now={now} />)
      ) : (
        // The active provider is always rendered even with no usable source, so
        // the panel never collapses to "only the credit provider that happened
        // to return data" (e.g. DeepSeek) regardless of who's active. The hint
        // is provider-aware (OpenCode plans → point at the console).
        <Text color={theme.muted} dimColor>
          {noDataHint(snapshot.provider)}
        </Text>
      )}
    </Box>
  )
}

function SessionSummary({ analysis }: { analysis: SessionAnalysis }) {
  const theme = useTheme()
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.muted}>This session (local)</Text>
      <Text dimColor>Turns this session: {analysis.turns}</Text>
      {analysis.highContextPct > 0 && (
        <Text dimColor>
          {analysis.highContextPct}% of turns ran at &gt;
          {formatTokens(analysis.highContextThreshold)} context
        </Text>
      )}
      {analysis.dispatchCalls > 0 && (
        <Text dimColor>
          {analysis.dispatchCalls} subagent dispatch
          {analysis.dispatchCalls === 1 ? "" : "es"}
        </Text>
      )}
    </Box>
  )
}

export function LimitsPanel({
  snapshots,
  analysis,
  now,
  rateLimits,
  activeProvider,
  onClose,
}: {
  snapshots: ProviderLimits[]
  analysis: SessionAnalysis
  /** Render clock for the reset countdowns (captured when the panel opened). */
  now: number
  /** Live API rate-limit reading, when one has been captured this session. */
  rateLimits?: RateLimitSnapshot
  /** Active provider id — its block is badged `● active`. */
  activeProvider?: string
  onClose: () => void
}) {
  const theme = useTheme()
  useInput((_input, key) => {
    if (key.escape || key.return) onClose()
  })
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.accent}>
        Subscription limits
      </Text>
      {rateLimits && rateLimits.meters.length > 0 && (
        <RateLimitBlock snapshot={rateLimits} now={now} />
      )}
      {snapshots.map((s) => (
        <ProviderBlock
          key={`${s.provider}:${s.accountId ?? ""}`}
          snapshot={s}
          now={now}
          active={activeProvider != null && s.accountId === activeProvider}
        />
      ))}
      {/* Onboarding hint whenever NO account carries usable data — shown both
          when the list is empty and when the only block is a no-data active
          provider, so the "add a token" pointer is never lost. */}
      {!snapshots.some((s) => s.meters.length > 0 || s.error) && (
        <Text color={theme.muted}>
          No subscription limit data — add a Claude/Codex subscription token or a credit-provider
          key, then run /limits again.
        </Text>
      )}
      <SessionSummary analysis={analysis} />
      <Text color={theme.muted} dimColor>
        esc to close
      </Text>
    </Box>
  )
}
