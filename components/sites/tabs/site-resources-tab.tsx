"use client"

/**
 * Every provider resource Cognia recorded, and what a purge would do to it.
 *
 * The old panel listed one of the eight `SiteResourceKind`s (custom domains)
 * and never showed `ownership` at all — even though purge deletes only
 * `managed` resources and ADR-0084 requires the adopted/shared ones to be
 * reported as preserved. Ownership therefore gets its own visual channel here
 * (left-edge stripe plus an icon chip) so "will be deleted" never reads as
 * "something is broken".
 */
import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { LayersIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { formatBytesCompact } from "@/lib/observability/format-utils"
import {
  groupResourcesByKind,
  purgeRetentionReport,
  siteArtifactStorage,
} from "@/lib/sites/console-model"
import { cn } from "@/lib/utils"
import type { SiteGate } from "@/hooks/sites/use-site-action-gate"
import type { SiteResourceRow, SiteVersionRow } from "@/types/sites"
import {
  SITE_OWNERSHIP_STRIPE,
  SITE_RESOURCE_FACE,
  SITE_RESOURCE_KIND_ICON,
  SiteOwnershipChip,
  SiteStatusPill,
} from "../site-status"

export interface SiteResourcesTabProps {
  resources: readonly SiteResourceRow[]
  /** Drives the local archive footprint; ADR-0084's retention made visible. */
  versions: readonly SiteVersionRow[]
  gate: SiteGate
  /**
   * Per-key busy predicate from `useSiteActions`. `isBusy(key)` is true while
   * that action is in flight or an exclusive lifecycle action is running; a
   * build no longer disables unrelated controls.
   */
  isBusy: (key?: string) => boolean
  onReconcile: () => void
  /** Runs artifact retention now instead of waiting for the daily sweep. */
  onReclaim: () => void
}

export function SiteResourcesTab({
  resources,
  versions,
  gate,
  isBusy,
  onReconcile,
  onReclaim,
}: SiteResourcesTabProps) {
  const t = useTranslations("sites")
  const groups = useMemo(() => groupResourcesByKind(resources), [resources])
  const retention = useMemo(() => purgeRetentionReport(resources), [resources])
  const storage = useMemo(() => siteArtifactStorage(versions), [versions])

  const storageRow = (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2 text-xs"
      data-testid="site-artifact-storage"
    >
      <span className="font-medium">{t("storage.title")}</span>
      <span className="tabular-nums">
        {t("storage.used", { size: formatBytesCompact(storage.bytes), count: storage.stored })}
      </span>
      {storage.collected > 0 ? (
        <span className="text-muted-foreground">
          {t("storage.collected", { count: storage.collected })}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {t("storage.description")}
      </span>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={isBusy("reclaim") || storage.stored === 0}
        onClick={onReclaim}
        data-testid="site-reclaim-artifacts"
      >
        {t("storage.reclaim")}
      </Button>
    </div>
  )

  if (resources.length === 0) {
    return (
      <div className="space-y-3" data-testid="site-resources-tab-empty">
        {storageRow}
        <Empty role="status" className="gap-3 px-4 py-12" data-testid="site-resources-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="bg-primary/10 text-primary">
              <LayersIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle className="text-sm">{t("resources.title")}</EmptyTitle>
            <EmptyDescription className="max-w-[22rem] text-xs">
              {t("resources.empty")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  return (
    <div className="space-y-3" data-testid="site-resources-tab">
      {storageRow}

      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
        <span className="font-medium">{t("resources.retention.title")}</span>
        <span className="text-warning" data-testid="site-purge-scope-deleted">
          {t("resources.retention.purgeable", { count: retention.purgeable.length })}
        </span>
        <span className="text-muted-foreground" data-testid="site-purge-scope-retained">
          {t("resources.retention.retained", { count: retention.retained.length })}
        </span>
        <span className="text-muted-foreground">{t("resources.legend")}</span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="ml-auto"
          disabled={isBusy("reconcile") || !gate.allowed}
          title={gate.title}
          onClick={onReconcile}
          data-testid="site-reconcile"
        >
          {t("actions.reconcile")}
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border">
        {groups.map((group) => {
          const KindIcon = SITE_RESOURCE_KIND_ICON[group.kind] ?? LayersIcon
          return (
            <section key={group.kind} data-testid={`site-resource-group-${group.kind}`}>
              <h3 className="flex items-center gap-2 border-b bg-background/95 px-3 py-1.5 backdrop-blur">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t(`resources.kind.${group.kind}`)}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {group.rows.length}
                </span>
              </h3>
              {group.rows.map((row) => (
                <div
                  key={row.id}
                  data-testid={`site-resource-${row.id}`}
                  className={cn(
                    "flex flex-wrap items-center gap-2 border-b border-l-2 px-3 py-2.5 last:border-b-0 transition-colors hover:bg-accent/50 motion-reduce:transition-none",
                    SITE_OWNERSHIP_STRIPE[row.ownership],
                    row.status === "deleted" && "opacity-60"
                  )}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                    <KindIcon aria-hidden className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {row.displayName ?? row.providerResourceId}
                    </span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {row.kind}/{row.providerResourceId}
                    </span>
                  </span>
                  {row.dependencies.length > 0 ? (
                    <Badge variant="outline" className="font-normal tabular-nums">
                      {t("resources.dependencies", { count: row.dependencies.length })}
                    </Badge>
                  ) : null}
                  <SiteOwnershipChip
                    ownership={row.ownership}
                    label={t(`resources.ownershipHint.${row.ownership}`)}
                  />
                  <SiteStatusPill
                    face={SITE_RESOURCE_FACE[row.status]}
                    label={t(`resources.status.${row.status}`)}
                  />
                </div>
              ))}
            </section>
          )
        })}
      </div>
    </div>
  )
}
