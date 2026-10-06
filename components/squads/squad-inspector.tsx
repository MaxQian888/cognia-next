"use client"

/**
 * One Squad's identity and its run controls.
 *
 * Extracted from the fleet console so the phone sheet and the desktop right
 * pane cannot drift. Starts route to the execution host and controls use the
 * canonical execution journal, including the remote mirror.
 *
 * The body arrives as `children` rather than as a `bodyTab` prop. A prop only
 * one host would ever set is dormancy the repo's dormancy rule would make me
 * label on three axes, and composition owes nothing.
 */

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { ExternalLinkIcon, SettingsIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { useClientLiveQuery } from "@/hooks/data"
import { useHostProfile, useRemoteHostActive } from "@/hooks/use-host-profile"
import { getDb } from "@/lib/db/schema"
import {
  createSquadStartAttempt,
  type SquadStartOutcome,
} from "@/lib/execution/squad-start-dispatch"
import { dispatchRunControl } from "@/lib/execution/run-control-dispatch"

import { TeamRunControls } from "@/components/agent/workspace/team-run-controls"
import { squadPanelId } from "@/components/settings/squads/nav-config"
import { SquadReadinessCard } from "@/components/squads/squad-readiness-card"
import { useSquadReadiness } from "@/hooks/squads/use-squad-readiness"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { settingsHref } from "@/lib/settings/deep-link"
import { cn } from "@/lib/utils"

export interface SquadInspectorProps {
  squadId: string
  children?: React.ReactNode
  className?: string
  /**
   * Print the Squad's name and description. Off where the host already titles
   * the surface with them (the phone drawer's header), which otherwise showed
   * both twice, one line apart.
   */
  showIdentity?: boolean
}

export function SquadInspector(props: SquadInspectorProps) {
  return <SquadInspectorContent key={props.squadId} {...props} />
}

function SquadInspectorContent({
  squadId,
  children,
  className,
  showIdentity = true,
}: SquadInspectorProps) {
  const t = useTranslations("squads.fleet")
  const tReadiness = useTranslations("squads.readiness")
  const squad = useAgentTeamStore((s) => s.teams[squadId])
  const readiness = useSquadReadiness(squadId)
  const hostProfile = useHostProfile()
  const activeRemote = useRemoteHostActive()
  const remote =
    hostProfile === "mobile-companion" || hostProfile === "cloud-companion" || activeRemote
  const tControl = useTranslations("squads.fleet.control")
  const tRun = useTranslations("agentRuns.outcome")
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const attemptRef = useRef<ReturnType<typeof createSquadStartAttempt> | null>(null)
  const [startOutcome, setStartOutcome] = useState<SquadStartOutcome | null>(null)
  const run = useClientLiveQuery(
    async () => {
      const rows = await getDb()
        .executionRuns.where("kind")
        .equals("team")
        .filter((row) => row.latestSnapshot?.teamId === squadId)
        .sortBy("updatedAt")
      return rows.at(-1) ?? null
    },
    [squadId],
    undefined
  )
  const blockerText = (blocker: NonNullable<SquadStartOutcome["blockers"]>[number]) =>
    tReadiness(`blockers.${blocker.code}`, {
      versionId: blocker.detail?.versionId ?? "",
      environmentId: blocker.detail?.environmentId ?? "",
      repositoryIds: (blocker.detail?.repositoryIds ?? []).join(", "),
      missingCapabilities: (blocker.detail?.missingCapabilities ?? []).join(", "),
    })
  // Environment and native workspace state are not mirrored to the companion.
  // Its admission belongs to the authoritative host, which returns blockers.
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
  const retryable =
    startOutcome &&
    !startOutcome.started &&
    ["host_consent_required", "approval_required", "start_failed", "offline"].includes(
      startOutcome.reason ?? ""
    )
  const start = async (ultracode?: boolean, retry = false) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      if (!retry || !attemptRef.current) {
        attemptRef.current = createSquadStartAttempt({
          teamId: squadId,
          hostProfile,
          ...(ultracode !== undefined ? { ultracode } : {}),
        })
      }
      setStartOutcome(await attemptRef.current.dispatch())
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const control = async (action: "pause" | "resume" | "stop") => {
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
  }
  const allowed = run?.latestSnapshot?.allowedActions ?? []
  const terminal = run && ["completed", "failed", "cancelled"].includes(run.status)
  const status = run
    ? terminal
      ? (run.status as "completed" | "failed" | "cancelled")
      : allowed.includes("resume")
        ? "paused"
        : "executing"
    : (squad?.status ?? "idle")
  const refusalKey = `startRefusal.${startOutcome?.reason ?? "start_failed"}`

  if (!squad) return null

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col", className)}
      data-testid="squad-fleet-inspector"
    >
      <div className="shrink-0 space-y-1 border-b p-3">
        {showIdentity ? (
          <>
            <p className="truncate text-sm font-medium">{squad.name}</p>
            {squad.description ? (
              <p className="line-clamp-2 text-xs text-muted-foreground">{squad.description}</p>
            ) : null}
          </>
        ) : null}
        <TeamRunControls
          status={status}
          ultracodeEnabled={squad.config?.ultracode?.enabled}
          onStart={() => void start(undefined, Boolean(retryable))}
          onStartUltracode={() => void start(true)}
          onPause={!busy && allowed.includes("pause") ? () => void control("pause") : undefined}
          onResume={!busy && allowed.includes("resume") ? () => void control("resume") : undefined}
          onStop={!busy && allowed.includes("stop") ? () => void control("stop") : undefined}
          {...(startDisabledReason ? { startDisabledReason } : {})}
          className="pt-1"
        />
        {remote ? (
          <p className="pt-2 text-xs text-muted-foreground">{tControl("remoteReadiness")}</p>
        ) : (
          <SquadReadinessCard squadId={squad.id} className="mt-2" />
        )}
        {startOutcome && !startOutcome.started && (
          <div role="alert" className="space-y-2 pt-2 text-sm">
            <p>{tControl(tControl.has(refusalKey) ? refusalKey : "startRefusal.start_failed")}</p>
            {startOutcome.consentCode && (
              <p>
                {tRun("consentCode")} <code>{startOutcome.consentCode}</code>
              </p>
            )}
            {startOutcome.blockers?.length ? (
              <ul>
                {startOutcome.blockers.map((blocker) => (
                  <li key={blocker.code}>{blockerText(blocker)}</li>
                ))}
              </ul>
            ) : null}
            {retryable && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void start(undefined, true)}
              >
                {tControl("retryStart")}
              </Button>
            )}
          </div>
        )}
        {(startOutcome?.executionRunId || run?.id) && (
          <Link
            className="block pt-2 text-sm underline"
            href={`/agent-runs?kind=team&run=${encodeURIComponent(startOutcome?.executionRunId ?? run!.id)}`}
          >
            {tControl("openRun")}
          </Link>
        )}
        <Link
          href={settingsHref("squads", { params: { squadTab: squadPanelId(squad.id) } })}
          className="inline-flex items-center gap-1 pt-1 text-xs text-muted-foreground hover:text-foreground"
          data-testid="squad-fleet-configure"
        >
          <SettingsIcon aria-hidden className="size-3" />
          {/* Configuration is not on this page on purpose: one place per
              question, and this page answers "what is running". */}
          {t("configure")}
          <ExternalLinkIcon aria-hidden className="size-3" />
        </Link>
      </div>
      {children ? <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div> : null}
    </div>
  )
}
