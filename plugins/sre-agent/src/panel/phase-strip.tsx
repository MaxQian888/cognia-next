"use client"

import { CheckIcon, CircleIcon, CircleDotIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  derivePhase,
  phaseIndex,
  SRE_INCIDENT_PHASES,
  type SreIncident,
  type SreIncidentPhase,
} from "../incident/model"
import { usePluginT } from "../use-plugin-t"

const PHASE_ICON = {
  done: CheckIcon,
  current: CircleDotIcon,
  todo: CircleIcon,
} as const

type PhaseState = keyof typeof PHASE_ICON

function stateOf(current: SreIncidentPhase, phase: SreIncidentPhase): PhaseState {
  const delta = phaseIndex(phase) - phaseIndex(current)
  if (delta < 0) return "done"
  return delta === 0 ? "current" : "todo"
}

/**
 * The four investigation phases, read off the incident rather than stored.
 *
 * `compact` is the narrow-column form: at 360px four labelled steps with rules
 * between them wrap into an unreadable stack, so the labels collapse to the
 * current one and the rest become dots.
 */
export function PhaseStrip({
  incident,
  compact = false,
}: {
  incident: SreIncident
  compact?: boolean
}) {
  const t = usePluginT()
  const current = derivePhase(incident)

  return (
    <div
      className="flex items-center gap-1"
      role="list"
      aria-label={t("phase.label")}
      data-testid="sre-phase-strip"
      data-phase={current}
    >
      {SRE_INCIDENT_PHASES.map((phase, index) => {
        const state = stateOf(current, phase)
        const Icon = PHASE_ICON[state]
        const showLabel = !compact || state === "current"
        return (
          <div key={phase} className="flex min-w-0 items-center gap-1" role="listitem">
            {index > 0 ? (
              <span
                aria-hidden
                className={cn(
                  "h-px w-3 shrink-0",
                  compact ? "hidden" : "block",
                  state === "todo" ? "bg-border" : "bg-muted-foreground/40"
                )}
              />
            ) : null}
            <Icon
              className={cn(
                "size-3.5 shrink-0",
                state === "done" && "text-green-600 dark:text-green-500",
                state === "current" && "text-primary",
                state === "todo" && "text-muted-foreground/50"
              )}
            />
            {showLabel ? (
              <span
                className={cn(
                  "truncate text-xs",
                  state === "current" ? "font-medium text-foreground" : "text-muted-foreground"
                )}
              >
                {t(`phase.${phase}`)}
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
