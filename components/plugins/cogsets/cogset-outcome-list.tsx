"use client"

import { useTranslations } from "next-intl"
import { CircleAlertIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { CogsetPluginOutcome } from "@/types/plugin/plugin-cogset"

export interface CogsetOutcomeListProps {
  outcomes: readonly CogsetPluginOutcome[]
  /** Localized name for a plugin id; falls back to the id. */
  pluginName: (pluginId: string) => string
}

/** A version range for display; `*` and an absent range mean any version. */
function constraintArg(constraint: string | undefined): string {
  const trimmed = constraint?.trim()
  return !trimmed || trimmed === "*" ? "any" : trimmed
}

/** The plugins an activation could not bring to the state the cogset asks for. */
export function CogsetOutcomeList({ outcomes, pluginName }: CogsetOutcomeListProps) {
  const t = useTranslations("plugins.cogsets")
  const problems = outcomes.filter((outcome) => !outcome.ok)
  if (problems.length === 0) return null
  return (
    <ul className="divide-y rounded-md border" data-testid="cogset-outcome-list">
      {problems.map((outcome) => (
        <li
          key={`${outcome.pluginId}:${outcome.action}:${outcome.reason ?? ""}:${outcome.dependencyId ?? ""}`}
          className="flex items-start gap-2 px-3 py-2 text-sm"
        >
          <CircleAlertIcon
            className={
              outcome.optional
                ? "mt-0.5 size-4 shrink-0 text-muted-foreground"
                : "mt-0.5 size-4 shrink-0 text-destructive"
            }
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium break-words">{pluginName(outcome.pluginId)}</span>
              <span className="text-xs text-muted-foreground">{t(`action.${outcome.action}`)}</span>
              {outcome.optional && <Badge variant="outline">{t("activation.optional")}</Badge>}
            </div>
            {outcome.reason && (
              <p className="text-xs text-muted-foreground">
                {t(`reason.${outcome.reason}`, {
                  installed: outcome.installedVersion ?? "",
                  expected: outcome.expectedVersion ?? "",
                  dependency: outcome.dependencyId ? pluginName(outcome.dependencyId) : "",
                  constraint: constraintArg(outcome.dependencyConstraint),
                  found: outcome.dependencyFound ?? "",
                  cycle: (outcome.cycle ?? []).map(pluginName).join(" → "),
                })}
              </p>
            )}
            {outcome.message && (
              <p className="text-xs break-words text-muted-foreground/80">{outcome.message}</p>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}
