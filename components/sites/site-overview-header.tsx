"use client"

/**
 * The persistent header above the console's tabs.
 *
 * Two things live here that the panel never showed before:
 *
 *  - **The production URL.** `deployVersion` writes `productionUrl` on every
 *    successful deploy and nothing rendered it, so finishing a publish produced
 *    no visible result and no way to open the site.
 *  - **Unresolved failures.** Version, deployment, and operation failure
 *    messages were all dropped; a failed build left a red chip and a toast that
 *    had already disappeared.
 *
 * Lifecycle actions live here too, since they act on the Site as a whole rather
 * than on any one tab.
 */
import { useTranslations, useFormatter, useNow } from "next-intl"
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  LinkIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react"

import { ExternalLink } from "@/components/shared/external-link"
import { Surface } from "@/components/surface/surface"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useCopy } from "@/hooks/ui"
import {
  collectSiteFailures,
  currentVersion,
  pickActiveDeployment,
  siteProductionUrl,
  siteViewerRole,
} from "@/lib/sites/console-model"
import { cn } from "@/lib/utils"
import type {
  SiteDeploymentRow,
  SiteOperationRow,
  SiteProjectRow,
  SiteResourceRow,
  SiteVersionRow,
} from "@/types/sites"
import type { SiteGate } from "@/hooks/sites/use-site-action-gate"
import { SiteHeroStats } from "./site-hero-stats"
import { SITE_DEPLOYMENT_FACE, SITE_LIFECYCLE_FACE, SiteStatusPill } from "./site-status"

export interface SiteOverviewHeaderProps {
  site: SiteProjectRow
  versions: readonly SiteVersionRow[]
  deployments: readonly SiteDeploymentRow[]
  operations: readonly SiteOperationRow[]
  resources: readonly SiteResourceRow[]
  actorAccountId: string
  gate: SiteGate
  metadataGate: SiteGate
  /**
   * Per-key busy predicate from `useSiteActions`. `isBusy(key)` is true while
   * that action is in flight or an exclusive lifecycle action is running; a
   * build no longer disables unrelated controls.
   */
  isBusy: (key?: string) => boolean
  onTakeDown: () => void
  onRestore: () => void
  onPurge: () => void
  onDeleteMetadata: () => void
}

export function SiteOverviewHeader({
  site,
  versions,
  deployments,
  operations,
  resources,
  actorAccountId,
  gate,
  metadataGate,
  isBusy,
  onTakeDown,
  onRestore,
  onPurge,
  onDeleteMetadata,
}: SiteOverviewHeaderProps) {
  const t = useTranslations("sites")
  const format = useFormatter()
  const now = useNow()
  const { copy, copied } = useCopy()

  const productionUrl = siteProductionUrl(deployments)
  const activeDeployment = pickActiveDeployment(deployments)
  const version = currentVersion(versions, deployments)
  const failures = collectSiteFailures(versions, deployments, operations)
  const role = siteViewerRole(site.authoringPolicy, actorAccountId)
  const sourcePath = site.sourceSubpath
    ? `${site.sourceRoot}/${site.sourceSubpath}`
    : site.sourceRoot

  return (
    <header
      className="shrink-0 border-b border-border/60 bg-background/60 px-4 py-3"
      data-testid="site-overview-header"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-lg font-semibold tracking-tight">{site.name}</h2>
            <SiteStatusPill
              face={SITE_LIFECYCLE_FACE[site.lifecycle]}
              label={t(`lifecycle.${site.lifecycle}`)}
            />
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground" title={sourcePath}>
            {sourcePath}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {site.lifecycle === "active" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBusy("takedown") || !gate.allowed}
              title={gate.title}
              onClick={onTakeDown}
              data-testid="site-take-down"
            >
              {t("actions.takeDown")}
            </Button>
          ) : null}
          {site.lifecycle === "taken-down" ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy("restore") || !gate.allowed}
                title={gate.title}
                onClick={onRestore}
                data-testid="site-restore"
              >
                {t("actions.restore")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={isBusy("purge") || !gate.allowed}
                title={gate.title}
                onClick={onPurge}
                data-testid="site-purge"
              >
                <Trash2Icon aria-hidden className="size-4" />
                {t("actions.purge")}
              </Button>
            </>
          ) : null}
          {site.lifecycle === "deleted" ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={isBusy("delete-metadata") || !metadataGate.allowed}
              title={metadataGate.title}
              onClick={onDeleteMetadata}
              data-testid="site-delete-metadata"
            >
              <Trash2Icon aria-hidden className="size-4" />
              {t("actions.deleteMetadata")}
            </Button>
          ) : null}
        </div>
      </div>

      <Surface
        layer="raised"
        radius="control"
        className="mt-3 flex flex-wrap items-center gap-2 border px-3 py-2"
      >
        <LinkIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        {productionUrl ? (
          <ExternalLink
            href={productionUrl}
            data-testid="site-production-url"
            className="min-w-0 flex-1 truncate font-mono text-sm underline-offset-4 hover:text-primary hover:underline"
          >
            {productionUrl}
          </ExternalLink>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {t("overview.noProductionUrl")}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("actions.copyUrl")}
          disabled={!productionUrl}
          onClick={() => productionUrl && void copy(productionUrl)}
        >
          {copied ? (
            <CheckIcon aria-hidden className="size-4 text-success" />
          ) : (
            <CopyIcon aria-hidden className="size-4" />
          )}
        </Button>
        {productionUrl ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("actions.openSite")}
            asChild
          >
            <ExternalLink href={productionUrl}>
              <ExternalLinkIcon aria-hidden className="size-4" />
            </ExternalLink>
          </Button>
        ) : null}
        {activeDeployment ? (
          <SiteStatusPill
            face={SITE_DEPLOYMENT_FACE[activeDeployment.status]}
            label={t(`deploymentStatus.${activeDeployment.status}`)}
            solid
          />
        ) : null}
      </Surface>

      <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
        <span>
          {version
            ? t("overview.currentVersion", { sequence: version.sequence })
            : t("overview.noVersion")}
        </span>
        {version ? (
          <>
            <span aria-hidden className="size-0.5 rounded-full bg-muted-foreground/60" />
            <code className="font-mono">{version.source.commitSha.slice(0, 7)}</code>
            {version.source.dirty ? (
              <Badge
                variant="outline"
                className="h-4 border-warning/40 px-1 text-[10px] font-normal text-warning"
              >
                {t("versions.dirty")}
              </Badge>
            ) : null}
          </>
        ) : null}
        {activeDeployment ? (
          <>
            <span aria-hidden className="size-0.5 rounded-full bg-muted-foreground/60" />
            <span>
              {t("overview.deployedAt", {
                when: format.relativeTime(new Date(activeDeployment.updatedAt), now),
              })}
            </span>
          </>
        ) : null}
        <span aria-hidden className="size-0.5 rounded-full bg-muted-foreground/60" />
        <span>
          {t("overview.owner")}:{" "}
          <code className="font-mono">{site.authoringPolicy.ownerAccountId}</code>
        </span>
        <span aria-hidden className="size-0.5 rounded-full bg-muted-foreground/60" />
        <span className={cn(role === "viewer" && "text-warning")}>
          {t("overview.yourRole")}: {t(`overview.role.${role}`)}
        </span>
      </p>

      <SiteHeroStats
        versions={versions}
        deployments={deployments}
        operations={operations}
        resources={resources}
      />

      {failures.length > 0 ? (
        <Alert variant="destructive" className="mt-3" data-testid="site-failure-banner">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>{t("overview.needsAttention", { count: failures.length })}</AlertTitle>
          <AlertDescription>
            <ul className="space-y-0.5">
              {failures.slice(0, 3).map((failure) => (
                <li key={`${failure.scope}:${failure.id}`} className="min-w-0">
                  <span className="font-medium">
                    {t(`overview.failureFrom.${failure.scope}`, { label: failure.label })}
                  </span>{" "}
                  <span className="break-words">{failure.message}</span>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </header>
  )
}
