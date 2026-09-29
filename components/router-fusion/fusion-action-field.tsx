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
 *    reason rather than silently failing at 3 a.m. The workspace is the
 *    project the caller's run is attributed to — the active project for a
 *    workflow (what the run is stamped with at admission), the team's project
 *    for a Squad member — and it counts only when that project has a checkout
 *    (`approvalKeyFor`, the same primary root the runtime asks for through
 *    `fusionWorkspaceRootOf`). One source on both sides, so a choice this
 *    allows is one the run can execute;
 *  - a `Delegate` choice also says how it delivers its change, when the host
 *    stores that (`onDeliveryChange`): a patch only (the default), or applied
 *    into the workspace after a person approves exactly that patch;
 *  - a value that was saved while it was allowed and no longer is (the switch
 *    went off, the workspace went away) is shown with the reason, so the
 *    author sees it before the run does.
 *
 * Every one of those is `validateFusionActionChoice`, asked once per option
 * and once for the stored value: one authority, not a picker's own copy.
 */

import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DELEGATE_DELIVERY_CHOICES,
  FUSION_ACTION_CHOICES,
  delegateDeliveryOf,
  fusionActionAvailability,
  fusionActionChoiceOf,
  validateFusionActionChoice,
  type DelegateDeliveryChoice,
  type FusionActionChoice,
} from "@/lib/router-fusion/gate/explicit-run"
import { approvalKeyFor } from "@/lib/project-environment/workspace-config-trust"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"

export interface FusionActionFieldProps {
  id: string
  value: unknown
  onChange: (value: FusionActionChoice) => void
  /**
   * The project the caller's run is attributed to; `delegate` needs it to
   * have a checkout. Omitted (`undefined`), the active project answers — which
   * is the project a workflow run is stamped with at admission. `null` says
   * the caller has no project at all.
   */
  projectId?: string | null
  /** The stored delegate delivery; read only while the action is `delegate`. */
  delivery?: unknown
  /** Store a delegate delivery. Without it, no delivery choice is offered. */
  onDeliveryChange?: (value: DelegateDeliveryChoice) => void
  /** Rendered by the inspector's own `Field`; standalone hosts pass their own. */
  className?: string
}

export function FusionActionField({
  id,
  value,
  onChange,
  projectId,
  delivery,
  onDeliveryChange,
  className,
}: FusionActionFieldProps) {
  const t = useTranslations("routerFusionModes")
  const settings = useSettingsStore((state) => state.settings)
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const projects = useProjectStore((state) => state.projects)
  const availability = fusionActionAvailability(settings)
  const action = fusionActionChoiceOf(value)
  const ownerId = projectId === undefined ? activeProjectId : projectId
  const owner = ownerId ? projects.find((project) => project.id === ownerId) : undefined
  const workspace = approvalKeyFor(owner) !== null
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
      {action === "delegate" && onDeliveryChange ? (
        <div className="mt-2 space-y-1">
          <Label className="text-xs" htmlFor={`${id}-delivery`}>
            {t("delivery.label")}
          </Label>
          <Select
            value={delegateDeliveryOf(delivery)}
            onValueChange={(next) => onDeliveryChange(delegateDeliveryOf(next))}
          >
            <SelectTrigger id={`${id}-delivery`} data-testid="fusion-delivery-trigger">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DELEGATE_DELIVERY_CHOICES.map((choice) => (
                <SelectItem key={choice} value={choice}>
                  {t(`delivery.values.${choice}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            {t(`delivery.hints.${delegateDeliveryOf(delivery)}`)}
          </p>
        </div>
      ) : null}
    </div>
  )
}
