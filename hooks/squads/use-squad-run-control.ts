"use client"

/**
 * Start, pause, resume and stop one Squad, and say why a start was refused.
 *
 * Lifted out of the fleet inspector, which was the only component that held
 * this state machine. The Squad's own view now puts the controls in its
 * masthead, above whichever tab is showing, and the overview reads the same
 * run and the same refusal, so the logic cannot live inside one of them.
 *
 * Starts route to the execution host through `createSquadStartAttempt`, and
 * every control goes through `dispatchRunControl` against the canonical
 * execution journal, including the remote mirror (ADR-0169). Nothing here
 * talks to a Squad runtime directly.
 *
 * A start attempt is kept across a retry. A retry of a start the Host may or
 * may not have received must replay the SAME launch id with fresh lease keys,
 * or a lost response turns into two runs. A fresh gesture after a settled
 * outcome mints a new attempt.
 */

import { useCallback, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useHostProfile, useRemoteHostActive } from "@/hooks/use-host-profile"
import { useSquadLatestRun } from "@/hooks/squads/use-squad-latest-run"
import { useSquadReadiness } from "@/hooks/squads/use-squad-readiness"
import {
  createSquadStartAttempt,
  type SquadStartOutcome,
} from "@/lib/execution/squad-start-dispatch"
import { dispatchRunControl } from "@/lib/execution/run-control-dispatch"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam } from "@/types/agent/agent-team"
import type { AgentTeamRunRecord } from "@/types/agent/agent-team-runtime"
import type { ExecutionRun } from "@/types/execution/run"

export type SquadControlAction = "pause" | "resume" | "stop"
export type SquadStartBlocker = NonNullable<SquadStartOutcome["blockers"]>[number]

/** Refusals that a retry of the same gesture can clear. */
const RETRYABLE_REASONS: ReadonlySet<string> = new Set([
  "host_consent_required",
  "approval_required",
  "start_failed",
  "offline",
])

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])

export interface SquadRunControl {
  /** The newest run, or `null` before the first one. */
  run: ExecutionRun | null
  /** The durable record behind `run` (objective, resource usage), when carried here. */
  record: AgentTeamRunRecord | null
  /**
   * What the controls render for. The durable run wins over the store's
   * optimistic status, so a paused run reads paused even while the store still
   * says executing.
   */
  status: AgentTeam["status"]
  /** A start or a control is in flight. */
  busy: boolean
  /** On a companion or a remote host, where readiness is the Host's to judge. */
  remote: boolean
  /** Why Start is unavailable right now, or `undefined` when it is available. */
  startDisabledReason: string | undefined
  /** The last start's outcome, kept until the next gesture. */
  startOutcome: SquadStartOutcome | null
  /** The last start was refused for a reason a retry can clear. */
  retryable: boolean
  /** The refusal sentence for `startOutcome`, when it was refused. */
  refusalMessage: string | undefined
  /** Every blocker sentence the Host returned with the refusal. */
  refusalBlockers: string[]
  canPause: boolean
  canResume: boolean
  canStop: boolean
  start: (options?: { ultracode?: boolean; retry?: boolean }) => Promise<void>
  control: (action: SquadControlAction) => Promise<void>
}

export function useSquadRunControl(squadId: string): SquadRunControl {
  const tReadiness = useTranslations("squads.readiness")
  const tControl = useTranslations("squads.fleet.control")
  const tRun = useTranslations("agentRuns.outcome")
  const squad = useAgentTeamStore((s) => s.teams[squadId])
  const readiness = useSquadReadiness(squadId)
  const { run, record } = useSquadLatestRun(squadId)
  const hostProfile = useHostProfile()
  const activeRemote = useRemoteHostActive()
  const remote =
    hostProfile === "mobile-companion" || hostProfile === "cloud-companion" || activeRemote

  const [busy, setBusy] = useState(false)
  // The ref is the guard, the state is the render. A double-click lands both
  // clicks before React re-renders, so `busy` alone would let two through.
  const busyRef = useRef(false)
  const attemptRef = useRef<ReturnType<typeof createSquadStartAttempt> | null>(null)
  const [startOutcome, setStartOutcome] = useState<SquadStartOutcome | null>(null)

  const blockerText = useCallback(
    (blocker: SquadStartBlocker) =>
      tReadiness(`blockers.${blocker.code}`, {
        versionId: blocker.detail?.versionId ?? "",
        environmentId: blocker.detail?.environmentId ?? "",
        repositoryIds: (blocker.detail?.repositoryIds ?? []).join(", "),
        missingCapabilities: (blocker.detail?.missingCapabilities ?? []).join(", "),
      }),
    [tReadiness]
  )

  // Environment and native workspace state are not mirrored to a companion.
  // Its admission belongs to the authoritative Host, which returns blockers.
  const firstBlocker = readiness.loading ? undefined : readiness.blockers[0]
  const startDisabledReason = busy
    ? tControl("pending")
    : startOutcome?.started && run?.id !== startOutcome.executionRunId
      ? tControl("awaitingProjection")
      : !remote && readiness.loading
        ? tReadiness("loading")
        : !remote && firstBlocker
          ? blockerText(firstBlocker)
          : undefined

  const retryable = Boolean(
    startOutcome && !startOutcome.started && RETRYABLE_REASONS.has(startOutcome.reason ?? "")
  )

  const start = useCallback(
    async (options: { ultracode?: boolean; retry?: boolean } = {}) => {
      if (busyRef.current) return
      busyRef.current = true
      setBusy(true)
      try {
        if (!options.retry || !attemptRef.current) {
          attemptRef.current = createSquadStartAttempt({
            teamId: squadId,
            hostProfile,
            ...(options.ultracode !== undefined ? { ultracode: options.ultracode } : {}),
          })
        }
        setStartOutcome(await attemptRef.current.dispatch())
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [squadId, hostProfile]
  )

  const control = useCallback(
    async (action: SquadControlAction) => {
      if (busyRef.current || !run) return
      busyRef.current = true
      setBusy(true)
      try {
        const result = await dispatchRunControl({
          runId: run.id,
          action,
          surface: "squad-inspector",
          hostProfile,
        })
        if (!result.accepted) {
          toast.error(tControl(`failed.${action}`), {
            description: [
              tRun(result.reason ?? "control_failed"),
              result.consentCode ? `${tRun("consentCode")} ${result.consentCode}` : "",
            ]
              .filter(Boolean)
              .join(" "),
          })
        }
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [run, hostProfile, tControl, tRun]
  )

  const allowed = run?.latestSnapshot?.allowedActions ?? []
  const terminal = run ? TERMINAL_RUN_STATUSES.has(run.status) : false
  const status: AgentTeam["status"] = run
    ? terminal
      ? (run.status as "completed" | "failed" | "cancelled")
      : allowed.includes("resume")
        ? "paused"
        : "executing"
    : (squad?.status ?? "idle")

  const refusalKey = `startRefusal.${startOutcome?.reason ?? "start_failed"}`
  const refused = Boolean(startOutcome && !startOutcome.started)

  return {
    run,
    record,
    status,
    busy,
    remote,
    startDisabledReason,
    startOutcome,
    retryable,
    refusalMessage: refused
      ? tControl(tControl.has(refusalKey) ? refusalKey : "startRefusal.start_failed")
      : undefined,
    refusalBlockers: refused ? (startOutcome?.blockers ?? []).map(blockerText) : [],
    canPause: !busy && allowed.includes("pause"),
    canResume: !busy && allowed.includes("resume"),
    canStop: !busy && allowed.includes("stop"),
    start,
    control,
  }
}
