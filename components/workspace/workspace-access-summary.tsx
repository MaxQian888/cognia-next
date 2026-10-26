"use client"

/**
 * What the signed-in person may do in this workspace, and which shared
 * features this organization is offered, as the collaboration server says.
 *
 * # Why a card, and why the reasons are spelled out
 *
 * Roles alone do not answer "why can't I share this conversation?". The
 * answer can be the role, the operator pausing the feature, the org not being
 * in the rollout yet, or this app being too old, and each wants a different
 * next step. The server already decided which; this card says it, in the
 * reader's locale, instead of greying a button with no explanation.
 *
 * # Mirror only
 *
 * Nothing here gates anything. Every write is decided by the server again on
 * its own request (`lib/collab/capabilities.ts`).
 */

import { useTranslations } from "next-intl"
import { RefreshCwIcon, ShieldCheckIcon } from "lucide-react"

import { ConsoleSection } from "@/components/surface/console-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  COLLAB_ACTIONS,
  COLLAB_FEATURE_KEYS,
  type CollabFeatureState,
} from "@/lib/collab/capabilities"
import { cn } from "@/lib/utils"
import {
  useOrgCapabilities,
  type UseOrgCapabilitiesDeps,
} from "@/hooks/collab/use-org-capabilities"

const STATE_TONE: Record<CollabFeatureState, string> = {
  available: "border-emerald-500/30 text-emerald-700 dark:text-emerald-400",
  "existing-only": "border-amber-500/30 text-amber-700 dark:text-amber-400",
  "read-only": "border-destructive/30 text-destructive",
  off: "text-muted-foreground",
}

export interface WorkspaceAccessSummaryProps {
  workspaceId: string | null
  deps?: UseOrgCapabilitiesDeps
}

export function WorkspaceAccessSummary({ workspaceId, deps }: WorkspaceAccessSummaryProps) {
  const t = useTranslations("workspace.access")
  const tCaps = useTranslations("collabCapabilities")
  const tWorkspaceRole = useTranslations("workspace.members.role")
  const tOrgRole = useTranslations("account.identity.roleName")
  const view = useOrgCapabilities(workspaceId, deps)

  if (!workspaceId) return null

  // Not configured is the ordinary case for a workspace nobody shares; the
  // members card already says how to set collaboration up, so this one stays
  // out of the way rather than repeating it.
  if (view.status === "unavailable" && view.reason === "not-configured") return null

  return (
    <ConsoleSection
      id="access"
      pane="workspace-pane"
      idPrefix="workspace-section"
      icon={ShieldCheckIcon}
      title={t("title")}
      meta={
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6"
          aria-label={t("refresh")}
          onClick={view.refresh}
          data-testid="workspace-access-refresh"
        >
          <RefreshCwIcon className="size-3.5" aria-hidden />
        </Button>
      }
    >
      <div className="flex flex-col gap-3 text-xs" data-testid="workspace-access">
        {view.status === "loading" ? (
          <div
            role="status"
            aria-busy="true"
            aria-label={t("loading")}
            className="flex flex-col gap-1.5"
            data-testid="workspace-access-loading"
          >
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        ) : view.status === "ready" ? (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">{t("orgRole")}</dt>
              <dd data-testid="workspace-access-org-role">
                {view.capabilities.standing.orgRole
                  ? tOrgRole(view.capabilities.standing.orgRole)
                  : view.capabilities.standing.guest
                    ? t("guest")
                    : t("none")}
              </dd>
              <dt className="text-muted-foreground">{t("workspaceRole")}</dt>
              <dd data-testid="workspace-access-workspace-role">
                {view.capabilities.standing.workspaceRole
                  ? tWorkspaceRole(view.capabilities.standing.workspaceRole)
                  : t("none")}
                {view.capabilities.standing.via === "org-admin" ? (
                  <span className="text-muted-foreground"> · {t("viaOrgAdmin")}</span>
                ) : null}
              </dd>
            </dl>

            <section aria-labelledby="workspace-access-actions-heading">
              <h4
                id="workspace-access-actions-heading"
                className="pb-1 font-medium text-muted-foreground"
              >
                {t("actionsHeading")}
              </h4>
              {view.capabilities.actions.size === 0 ? (
                <p className="text-muted-foreground" data-testid="workspace-access-no-actions">
                  {t("noActions")}
                </p>
              ) : (
                <ul className="flex flex-wrap gap-1" data-testid="workspace-access-actions">
                  {/* Contract order, so the list reads the same for everyone. */}
                  {COLLAB_ACTIONS.filter((action) => view.capabilities.actions.has(action)).map(
                    (action) => (
                      <li key={action}>
                        <Badge variant="secondary" className="font-normal">
                          {tCaps(`action.${action}`)}
                        </Badge>
                      </li>
                    )
                  )}
                </ul>
              )}
            </section>

            <section aria-labelledby="workspace-access-features-heading">
              <h4
                id="workspace-access-features-heading"
                className="pb-1 font-medium text-muted-foreground"
              >
                {t("featuresHeading")}
              </h4>
              <ul className="flex flex-col gap-1.5" data-testid="workspace-access-features">
                {COLLAB_FEATURE_KEYS.map((key) => {
                  const decision = view.capabilities.features[key]
                  return (
                    <li
                      key={key}
                      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
                      data-testid={`workspace-access-feature-${key}`}
                      data-state={decision.state}
                    >
                      <span className="min-w-32 flex-1">{tCaps(`feature.${key}`)}</span>
                      <Badge
                        variant="outline"
                        className={cn("font-normal", STATE_TONE[decision.state])}
                      >
                        {tCaps(`state.${decision.state}`)}
                      </Badge>
                      {decision.reason ? (
                        <span className="basis-full text-muted-foreground">
                          {tCaps(`reason.${decision.reason}`)}
                        </span>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </section>
          </>
        ) : (
          <p
            className={cn(
              "text-muted-foreground",
              view.status === "error" ? "text-destructive" : undefined
            )}
            role={view.status === "error" ? "alert" : undefined}
            data-testid={`workspace-access-${view.status}`}
          >
            {view.status === "unavailable"
              ? t("unavailable.not-signed-in")
              : view.status === "error"
                ? t("unavailable.error", { message: view.message })
                : t(`unavailable.${view.status}`)}
          </p>
        )}
      </div>
    </ConsoleSection>
  )
}
