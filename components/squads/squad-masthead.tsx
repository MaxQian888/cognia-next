"use client"

/**
 * One Squad's masthead: who it is, what state it is in, and the verbs that act
 * on it, pinned above whichever of its tabs is showing.
 *
 * This replaces the fleet inspector, a fourth column on the wide pane. With a
 * Squad selected the page used to be rail | runs list | run detail | inspector,
 * and the inspector held the one control a reader came for (Start) in a column
 * a fifth of the width, while the run detail beside it was squeezed to make
 * room. The controls now sit at the top of the Squad's own view, where they
 * never scroll away and never compete with a run for width.
 *
 * Start is never disabled without saying why where everyone can see it. The
 * reason used to be the button's `title`, which no touch screen shows, so on a
 * phone a disabled Start simply looked broken.
 *
 * There is no "Open run" link here. The Overview's Latest run carries it beside
 * the run it opens, and the Runs tab is one click from any tab; a second copy
 * up here pointed at the same address and made two identical links on one
 * screen.
 *
 * The `squad-fleet-inspector` test id is the inspector's, kept on purpose: the
 * e2e suites (`tests/e2e/agent-runs/squad-run-controls.spec.ts`,
 * `tests/e2e/mobile/squad-remote-start.spec.ts`) address the control surface by
 * it, and this is that surface.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon, InfoIcon, SettingsIcon } from "lucide-react"

import { TeamRunControls } from "@/components/agent/workspace/team-run-controls"
import { squadPanelId } from "@/components/settings/squads/nav-config"
import { StatusBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { SquadRunControl } from "@/hooks/squads/use-squad-run-control"
import { settingsHref } from "@/lib/settings/deep-link"
import { cn } from "@/lib/utils"
import type { AgentTeam } from "@/types/agent/agent-team"

/** Statuses whose controls are Pause / Resume / Stop rather than Start. */
const START_HIDDEN_STATUSES: ReadonlySet<string> = new Set(["executing", "planning", "paused"])

export interface SquadMastheadProps {
  squad: AgentTeam
  memberCount: number
  /** Open reviews on this Squad's runs. */
  waitingCount: number
  control: SquadRunControl
  /** Present where the Squad view replaces the list (a phone): a way back to it. */
  onBack?: () => void
  className?: string
}

export function SquadMasthead({
  squad,
  memberCount,
  waitingCount,
  control,
  onBack,
  className,
}: SquadMastheadProps) {
  const t = useTranslations("squads.fleet")
  const tControl = useTranslations("squads.fleet.control")
  const tRun = useTranslations("agentRuns.outcome")
  const refused = Boolean(control.startOutcome && !control.startOutcome.started)
  // Only while Start is the verb on offer: a live or paused run has its own
  // controls, and "Sending…" while busy is transient, not a reason.
  const startOffered = !START_HIDDEN_STATUSES.has(control.status)
  const showStartReason = startOffered && !control.busy && Boolean(control.startDisabledReason)

  return (
    <header
      className={cn("@container/squad-masthead shrink-0 border-b px-4 py-3", className)}
      data-testid="squad-fleet-inspector"
    >
      <div className="flex flex-col gap-3 @2xl/squad-masthead:flex-row @2xl/squad-masthead:items-start @2xl/squad-masthead:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          {onBack ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="-ml-2 size-8 shrink-0"
              onClick={onBack}
              aria-label={t("detail.back")}
              data-testid="squad-detail-back"
            >
              <ArrowLeftIcon aria-hidden className="size-4" />
            </Button>
          ) : null}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="min-w-0 truncate text-base font-semibold" data-testid="squad-name">
                {squad.name}
              </h2>
              <StatusBadge
                value={control.status}
                labelNamespace="agentTeam.status"
                className="text-[10px]"
                pulse={control.status === "executing" || control.status === "planning"}
              />
              {waitingCount > 0 ? (
                <Badge
                  variant="destructive"
                  className="text-[10px]"
                  data-testid="squad-masthead-waiting"
                >
                  {t("detail.waitingCount", { count: waitingCount })}
                </Badge>
              ) : null}
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {t("memberCount", { count: memberCount })}
              {squad.description ? ` · ${squad.description}` : ""}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <TeamRunControls
            status={control.status}
            ultracodeEnabled={squad.config?.ultracode?.enabled}
            onStart={() => void control.start({ retry: control.retryable })}
            onStartUltracode={() => void control.start({ ultracode: true })}
            onPause={control.canPause ? () => void control.control("pause") : undefined}
            onResume={control.canResume ? () => void control.control("resume") : undefined}
            onStop={control.canStop ? () => void control.control("stop") : undefined}
            {...(control.startDisabledReason
              ? { startDisabledReason: control.startDisabledReason }
              : {})}
          />
          {/* Configuration is not on this page on purpose: one place per
              question, and this page answers "what is it doing". */}
          <Button asChild variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
            <Link
              href={settingsHref("squads", { params: { squadTab: squadPanelId(squad.id) } })}
              data-testid="squad-fleet-configure"
            >
              <SettingsIcon aria-hidden className="size-3.5" />
              {t("configure")}
            </Link>
          </Button>
        </div>
      </div>

      {showStartReason ? (
        <p
          className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground"
          data-testid="squad-start-reason"
        >
          <InfoIcon aria-hidden className="mt-px size-3.5 shrink-0" />
          <span className="line-clamp-2">
            {t("detail.cannotStart", { reason: control.startDisabledReason ?? "" })}
          </span>
        </p>
      ) : null}

      {refused ? (
        <div
          role="alert"
          className="mt-3 space-y-2 border-l-2 border-destructive pl-3 text-sm"
          data-testid="squad-start-refusal"
        >
          <p>{control.refusalMessage}</p>
          {control.startOutcome?.consentCode ? (
            <p>
              {tRun("consentCode")} <code>{control.startOutcome.consentCode}</code>
            </p>
          ) : null}
          {control.refusalBlockers.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              {control.refusalBlockers.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          ) : null}
          {control.retryable ? (
            <Button
              size="sm"
              variant="outline"
              disabled={control.busy}
              onClick={() => void control.start({ retry: true })}
            >
              {tControl("retryStart")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </header>
  )
}

export default SquadMasthead
