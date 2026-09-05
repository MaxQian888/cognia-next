"use client"

/**
 * Team run controls: the three-state Run / Pause / Resume / Stop block.
 *
 * There is no Abort (ADR-0168). It used to alias Pause, so the visible
 * destructive action read as "stop this" and did not. Pause is cooperative and
 * resumable. Stop is terminal and cascades. Those are the two verbs.
 *
 * Extracted from `overview.tsx` because two surfaces need the same block and
 * they place it differently: the desktop workspace pins it in the always-visible
 * `WorkspaceHeader` (so the primary action never scrolls out of reach), while the
 * mobile workspace has no header and keeps it inline in the Overview tab. Both
 * render this component, so the state machine below has exactly one definition.
 *
 * Takes the already-resolved live status rather than the team, so neither parent
 * pays for a second `useTeamLiveStatus` subscription and the component stays a
 * pure function of its props.
 *
 * The `data-testid`s are the historical ones from `overview.tsx` — unchanged so
 * existing suites and any external driver keep working.
 *
 * EVERY button is gated on its own handler. Pause and Stop always were; Start
 * and Resume were not, so a caller that omitted one rendered an enabled
 * button wired to `undefined`. That is how the mobile workspace shipped a
 * paused team with a Resume button that did nothing when tapped: an inert
 * control is worse than an absent one, because it reads as "the run refuses to
 * resume" rather than "this surface cannot resume it".
 */

import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { AgentTeam } from "@/types/agent/agent-team"

export interface TeamRunControlsProps {
  /** Resolved live status (durable run row wins over the optimistic store status). */
  status: AgentTeam["status"]
  /** Show the manual ultracode run button. Mirrors `team.config.ultracode?.enabled`. */
  ultracodeEnabled?: boolean
  onStart?: () => void
  /** Manual ultracode run — forces the pattern composition regardless of autoMode. */
  onStartUltracode?: () => void
  /** Pause the live run cooperatively (resumable). */
  onPause?: () => void
  /** Resume a paused team from its latest verified safe checkpoint. */
  onResume?: () => void
  /** Stop the run for good. Offered while live AND while paused. */
  onStop?: () => void
  /** Why Start is unavailable, when it is. Rendered as the disabled reason. */
  startDisabledReason?: string
  className?: string
}

export function TeamRunControls({
  status,
  ultracodeEnabled,
  onStart,
  onStartUltracode,
  onPause,
  onResume,
  onStop,
  startDisabledReason,
  className,
}: TeamRunControlsProps) {
  const t = useTranslations("agentTeamsWorkspace.overview")
  const isLive = status === "executing" || status === "planning"

  return (
    <div
      className={cn("flex items-center gap-2", className)}
      data-testid="team-run-controls"
      data-run-state={isLive ? "live" : status === "paused" ? "paused" : "idle"}
    >
      {isLive ? (
        <>
          {onPause && (
            <Button variant="outline" size="sm" onClick={onPause} data-testid="pause-team">
              {t("pauseTeam")}
            </Button>
          )}
          {onStop && (
            <Button variant="outline" size="sm" onClick={onStop} data-testid="stop-team">
              {t("stopTeam")}
            </Button>
          )}
        </>
      ) : status === "paused" ? (
        <>
          {onStop && (
            <Button variant="outline" size="sm" onClick={onStop} data-testid="stop-team">
              {t("stopTeam")}
            </Button>
          )}
          {onResume && (
            <Button size="sm" onClick={onResume} data-testid="resume-team">
              {t("resumeTeam")}
            </Button>
          )}
        </>
      ) : (
        <>
          {ultracodeEnabled && onStartUltracode && (
            <Button
              variant="outline"
              size="sm"
              onClick={onStartUltracode}
              disabled={Boolean(startDisabledReason)}
              data-testid="start-team-ultracode"
            >
              {t("startTeamUltracode")}
            </Button>
          )}
          {onStart && (
            <Button
              size="sm"
              onClick={onStart}
              disabled={Boolean(startDisabledReason)}
              title={startDisabledReason}
              data-testid="start-team"
            >
              {t("startTeam")}
            </Button>
          )}
        </>
      )}
    </div>
  )
}
