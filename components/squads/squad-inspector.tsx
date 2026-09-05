"use client"

/**
 * One Squad's identity and its run controls.
 *
 * Extracted from the fleet console so the phone sheet and the desktop right
 * pane cannot drift. The six `agentTeamManager` calls live here and only here.
 * Duplicating them into a mobile body is how one surface ends up able to stop a
 * run and the other only to pause it.
 *
 * The body arrives as `children` rather than as a `bodyTab` prop. A prop only
 * one host would ever set is dormancy the repo's dormancy rule would make me
 * label on three axes, and composition owes nothing.
 */

import { useTranslations } from "next-intl"
import Link from "next/link"
import { ExternalLinkIcon, SettingsIcon } from "lucide-react"

import { TeamRunControls } from "@/components/agent/workspace/team-run-controls"
import { squadPanelId } from "@/components/settings/squads/nav-config"
import { SquadReadinessCard } from "@/components/squads/squad-readiness-card"
import { useSquadReadiness } from "@/hooks/squads/use-squad-readiness"
import { agentTeamManager } from "@/lib/ai/agent/agent-team"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { settingsHref } from "@/lib/settings/deep-link"
import { cn } from "@/lib/utils"

export interface SquadInspectorProps {
  squadId: string
  children?: React.ReactNode
  className?: string
}

export function SquadInspector({ squadId, children, className }: SquadInspectorProps) {
  const t = useTranslations("squads.fleet")
  const tReadiness = useTranslations("squads.readiness")
  const squad = useAgentTeamStore((s) => s.teams[squadId])
  const readiness = useSquadReadiness(squadId)
  // The first blocker is the disabled reason on Start. The card below says
  // all of them, with the action that clears each.
  const firstBlocker = readiness.loading ? undefined : readiness.blockers[0]
  const startDisabledReason = readiness.loading
    ? tReadiness("loading")
    : firstBlocker
      ? tReadiness(`blockers.${firstBlocker.code}`, {
          versionId: firstBlocker.detail?.versionId ?? "",
          environmentId: firstBlocker.detail?.environmentId ?? "",
          repositoryIds: (firstBlocker.detail?.repositoryIds ?? []).join(", "),
          missingCapabilities: (firstBlocker.detail?.missingCapabilities ?? []).join(", "),
        })
      : undefined
  if (!squad) return null

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col", className)}
      data-testid="squad-fleet-inspector"
    >
      <div className="shrink-0 space-y-1 border-b p-3">
        <p className="truncate text-sm font-medium">{squad.name}</p>
        {squad.description ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{squad.description}</p>
        ) : null}
        {/* Start, pause, resume, stop. Without them a fleet console could say
            what every Squad was doing and do nothing about any of it, and these
            controls only ever existed on a tab of the retired
            `/agent-teams/workspace`. Acting on a run is runtime, not
            configuration, so this is the surface for it.

            Fire-and-forget: every one of these settles at terminal state and
            the row's own status is what reports back. */}
        <TeamRunControls
          status={squad.status}
          ultracodeEnabled={squad.config?.ultracode?.enabled}
          onStart={() => void agentTeamManager.start(squad.id).catch(() => undefined)}
          onStartUltracode={() =>
            void agentTeamManager.start(squad.id, { ultracode: true }).catch(() => undefined)
          }
          onPause={() => void agentTeamManager.pause(squad.id).catch(() => undefined)}
          onResume={() => void agentTeamManager.resume(squad.id).catch(() => undefined)}
          onStop={() => void agentTeamManager.shutdown(squad.id).catch(() => undefined)}
          {...(startDisabledReason ? { startDisabledReason } : {})}
          className="pt-1"
        />
        <SquadReadinessCard squadId={squad.id} className="mt-2" />
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
