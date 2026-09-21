"use client"

/**
 * The Router + Fusion action picker shared by the node inspector (ADR-0188 B5).
 *
 * `Auto` is the default and means the node behaves exactly as it always has.
 * The other values run the step as a fusion run on the `agentsWorkflows`
 * surface. What the picker must make obvious, because the cost of each is
 * different:
 *
 *  - with Router + Fusion off for agents and workflows, nothing but `Auto` can
 *    run, so every other option is disabled and the field says where to turn
 *    it on rather than letting an author save a choice that silently does
 *    nothing;
 *  - a mode this build cannot execute is offered disabled and labelled
 *    "Later release" (Rule 7). There is none today: every mode in
 *    `WIRED_FUSION_ACTION_MODES` runs;
 *  - `Delegate` edits files, so without a workspace it is disabled with that
 *    reason rather than silently failing at 3 a.m.;
 *  - a value that was saved while it was allowed and no longer is (the switch
 *    went off, the workspace went away) is shown with the reason, so the
 *    author sees it before the run does.
 *
 * Every one of those is `validateFusionActionChoice`, asked once per option
 * and once for the stored value: one authority, not a picker's own copy.
 */

import { useTranslations } from "next-intl"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  FUSION_ACTION_CHOICES,
  fusionActionAvailability,
  fusionActionChoiceOf,
  validateFusionActionChoice,
  type FusionActionChoice,
} from "@/lib/router-fusion/gate/explicit-run"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"

export interface FusionActionFieldProps {
  id: string
  value: unknown
  onChange: (value: FusionActionChoice) => void
  /**
   * Whether the caller has a workspace; `delegate` needs one to edit files in.
   * Omitted, the active project answers — which is the workspace a workflow
   * run is admitted with.
   */
  hasWorkspace?: boolean
  /** Rendered by the inspector's own `Field`; standalone hosts pass their own. */
  className?: string
}

export function FusionActionField({
  id,
  value,
  onChange,
  hasWorkspace,
  className,
}: FusionActionFieldProps) {
  const t = useTranslations("routerFusionModes")
  const settings = useSettingsStore((state) => state.settings)
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const availability = fusionActionAvailability(settings)
  const action = fusionActionChoiceOf(value)
  const workspace = hasWorkspace ?? activeProjectId !== null
  const issueOf = (choice: FusionActionChoice) =>
    validateFusionActionChoice({ action: choice, settings, hasWorkspace: workspace })
  const issue = issueOf(action)

  return (
    <div className={className}>
      <Select value={action} onValueChange={(next) => onChange(fusionActionChoiceOf(next))}>
        <SelectTrigger id={id} data-testid="fusion-action-trigger">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FUSION_ACTION_CHOICES.map((choice) => {
            if (choice === "auto") {
              return (
                <SelectItem key={choice} value={choice}>
                  {t("actions.auto")}
                </SelectItem>
              )
            }
            const dormant = availability.dormant.includes(choice)
            return (
              <SelectItem key={choice} value={choice} disabled={issueOf(choice) !== null}>
                {dormant
                  ? `${t(`actions.${choice}`)} — ${t("laterRelease")}`
                  : t(`actions.${choice}`)}
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
      <p className="text-muted-foreground mt-1 text-xs">{t(`hints.${action}`)}</p>
      {issue ? (
        <p className="text-destructive mt-1 text-xs" role="alert">
          {t(`errors.${issue}`)}
        </p>
      ) : null}
    </div>
  )
}
