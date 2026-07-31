"use client"

/**
 * AgentLivenessChip — whether an agent integration is actually *working*, as
 * opposed to merely *installed*.
 *
 * This exists because "installed" is not a checkable claim for every agent.
 * Codex gates hooks behind a trust the user grants inside its own TUI, keyed by
 * the hook command's content hash and not readable from disk — so writing
 * `~/.codex/hooks.json` successfully tells us nothing about whether a single
 * event will ever arrive. `codex_hooks.rs` says as much in its docs and
 * explicitly leaves the liveness question to its callers; until now no caller
 * answered it, which is how a Codex integration that produced zero rows for its
 * entire life kept reporting a healthy install.
 *
 * The three states map to the two clocks in the snapshot's `liveness` rows:
 *
 *   - nothing seen        → hooks have never fired (not trusted / not wired)
 *   - seen, never accepted → firing, but the payload contract doesn't match
 *   - accepted            → working; show how long ago
 */

import { useTranslations } from "next-intl"
import { formatElapsed } from "@/lib/fleet/format"
import { useNowTicker } from "@/hooks/fleet/use-now-ticker"
import type { AgentLiveness, FleetAgent } from "@/lib/fleet/types"
import { cn } from "@/lib/utils"

export type LivenessState = "silent" | "dropping" | "live"

/**
 * Derive the display state from an agent's liveness row. Pure.
 *
 * Explicit null checks, not truthiness: these are epoch timestamps, and `0` is
 * a value ("seen at epoch") rather than an absence.
 */
export function livenessState(liveness: AgentLiveness | undefined): LivenessState {
  if (liveness?.lastSeenAt == null) return "silent"
  return liveness.lastAcceptedAt == null ? "dropping" : "live"
}

const TONE: Record<LivenessState, string> = {
  // Amber, not red: a freshly-installed integration is legitimately silent
  // until the agent is next launched.
  silent: "border-amber-400/30 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  // Red: this one IS broken — events are arriving and being thrown away.
  dropping: "border-red-400/30 bg-red-500/10 text-red-600 dark:text-red-300",
  live: "border-emerald-400/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
}

export function AgentLivenessChip({
  agent,
  liveness,
  /** Whether the integration is installed at all; hidden when it isn't. */
  installed,
  className,
}: {
  agent: FleetAgent
  liveness: AgentLiveness | undefined
  installed: boolean
  className?: string
}) {
  const t = useTranslations("settings.fleet.liveness")
  // Shares the single fleet ticker rather than opening another interval.
  const nowMs = useNowTicker()
  if (!installed) return null

  const state = livenessState(liveness)
  const label =
    state === "live" && liveness?.lastAcceptedAt != null
      ? t("live", { ago: formatElapsed(liveness.lastAcceptedAt, nowMs) })
      : t(state)

  return (
    <span
      data-testid={`fleet-liveness-${agent}`}
      data-state={state}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
        TONE[state],
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1 rounded-full bg-current",
          state === "silent" && "motion-safe:animate-pulse"
        )}
      />
      {label}
    </span>
  )
}

export default AgentLivenessChip
