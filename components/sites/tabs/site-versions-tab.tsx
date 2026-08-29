"use client"

/**
 * Every immutable version, including the ones that never finished.
 *
 * The old panel listed `status === "ready"` versions only, so a failed build
 * simply disappeared — together with `failureMessage`, the one piece of text
 * that says what to fix. This shows all three statuses, the artifact and
 * binding facts recorded at build time, the deployment each version produced
 * (with its URL), and both failure messages.
 */
import { memo, useMemo, useRef, useState } from "react"
import { useTranslations, useFormatter, useNow } from "next-intl"
import { useVirtualizer } from "@tanstack/react-virtual"
import { PackageIcon, RocketIcon, UploadIcon } from "lucide-react"

import { ExternalLink } from "@/components/shared/external-link"
import { FilterChips } from "@/components/scheduler/filter-chips"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import {
  SITE_VERSION_STATUS_ORDER,
  countVersionsByStatus,
  filterVersionViews,
  joinVersionsWithDeployments,
  type SiteVersionView,
} from "@/lib/sites/console-model"
import { formatBytesCompact } from "@/lib/observability/format-utils"
import { cn } from "@/lib/utils"
import type { SiteGate } from "@/hooks/sites/use-site-action-gate"
import type {
  SiteDeploymentRow,
  SiteResourceRow,
  SiteVersionRow,
  SiteVersionStatus,
} from "@/types/sites"
import { SITE_DEPLOYMENT_FACE, SITE_VERSION_FACE, SiteStatusPill } from "../site-status"

type VersionFilter = SiteVersionStatus | "all"

interface SiteVersionRowProps {
  row: SiteVersionView
  uploadGate: SiteGate
  deployGate: SiteGate
  isBusy: (key?: string) => boolean
  onUpload: (version: SiteVersionRow) => void
  onDeploy: (version: SiteVersionRow) => void
}

/**
 * One version. Memoized because the list is virtualized and the console
 * re-renders on every operation write — without this, a build's progress
 * repaints every row on screen.
 */
const SiteVersionRow = memo(function SiteVersionRow({
  row: { version, deployment, uploaded, live },
  uploadGate,
  deployGate,
  isBusy,
  onUpload,
  onDeploy,
}: SiteVersionRowProps) {
  const t = useTranslations("sites")
  const format = useFormatter()
  const now = useNow()
  // Read straight off the version row (Dexie v202). This used to load the whole
  // archive out of `siteArtifacts` to recover two integers.
  const artifact =
    version.artifactSize !== undefined && version.artifactFileCount !== undefined
      ? { size: version.artifactSize, fileCount: version.artifactFileCount }
      : undefined
  return (
    <div
      data-testid={`site-version-${version.id}`}
      className={cn(
        "grid grid-cols-1 gap-2 border-b border-l-2 border-l-transparent px-3 py-3 last:border-b-0 transition-colors hover:bg-accent/50 motion-reduce:transition-none",
        "lg:grid-cols-[3.5rem_6rem_minmax(0,1fr)_10rem_auto] lg:items-center lg:gap-3",
        live && "border-l-success bg-success/5"
      )}
    >
      <span className="font-mono text-sm font-medium tabular-nums">v{version.sequence}</span>

      <SiteStatusPill
        face={SITE_VERSION_FACE[version.status]}
        label={t(`versions.status.${version.status}`)}
      />

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <code className="truncate font-mono text-xs text-muted-foreground">
          {version.source.commitSha.slice(0, 7)}
        </code>
        {version.source.dirty ? (
          <Badge
            variant="outline"
            className="h-4 border-warning/40 px-1 text-[10px] font-normal text-warning"
          >
            {t("versions.dirty")}
          </Badge>
        ) : null}
        {version.build.bindings.map((binding) => (
          <Badge
            key={binding.name}
            variant="outline"
            className="h-4 px-1 text-[10px] font-normal uppercase"
          >
            {binding.kind}
          </Badge>
        ))}
        {deployment ? (
          <SiteStatusPill
            face={SITE_DEPLOYMENT_FACE[deployment.status]}
            label={t(`deploymentStatus.${deployment.status}`)}
          />
        ) : null}
      </div>

      <span className="truncate font-mono text-xs tabular-nums text-muted-foreground">
        {artifact
          ? t("versions.artifact", {
              size: formatBytesCompact(artifact.size),
              count: artifact.fileCount,
            })
          : t("versions.noArtifact")}
      </span>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 lg:justify-end">
        <span className="text-xs text-muted-foreground">
          {format.relativeTime(new Date(version.completedAt ?? version.createdAt), now)}
        </span>
        {version.status === "ready" ? (
          uploaded ? (
            <Button
              type="button"
              size="sm"
              disabled={isBusy(`deploy:${version.id}`) || !deployGate.allowed}
              title={deployGate.title}
              onClick={() => onDeploy(version)}
              data-testid={`site-version-deploy-${version.id}`}
            >
              <RocketIcon aria-hidden className="size-4" />
              {deployment ? t("actions.rollback") : t("actions.deploy")}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isBusy(`upload:${version.id}`) || !uploadGate.allowed}
              title={uploadGate.title}
              onClick={() => onUpload(version)}
              data-testid={`site-version-upload-${version.id}`}
            >
              <UploadIcon aria-hidden className="size-4" />
              {t("actions.upload")}
            </Button>
          )
        ) : null}
      </div>

      {deployment?.productionUrl ? (
        <ExternalLink
          href={deployment.productionUrl}
          className="col-span-full min-w-0 truncate font-mono text-xs text-muted-foreground underline-offset-4 hover:text-primary hover:underline"
        >
          {deployment.productionUrl}
        </ExternalLink>
      ) : null}

      {version.failureMessage ? (
        <p
          role="alert"
          className="col-span-full rounded-md border border-destructive/40 bg-destructive/5 p-2 font-mono text-xs text-destructive"
        >
          {t("versions.failure")}: {version.failureMessage}
        </p>
      ) : null}

      {deployment?.failureMessage ? (
        <p
          role="alert"
          className="col-span-full rounded-md border border-destructive/40 bg-destructive/5 p-2 font-mono text-xs text-destructive"
        >
          {t("versions.deploymentFailure")}: {deployment.failureMessage}
        </p>
      ) : null}
    </div>
  )
})

export interface SiteVersionsTabProps {
  versions: readonly SiteVersionRow[]
  deployments: readonly SiteDeploymentRow[]
  resources: readonly SiteResourceRow[]
  uploadGate: SiteGate
  deployGate: SiteGate
  /**
   * Per-key busy predicate from `useSiteActions`. `isBusy(key)` is true while
   * that action is in flight or an exclusive lifecycle action is running; a
   * build no longer disables unrelated controls.
   */
  isBusy: (key?: string) => boolean
  onUpload: (version: SiteVersionRow) => void
  onDeploy: (version: SiteVersionRow) => void
}

export function SiteVersionsTab({
  versions,
  deployments,
  resources,
  uploadGate,
  deployGate,
  isBusy,
  onUpload,
  onDeploy,
}: SiteVersionsTabProps) {
  const t = useTranslations("sites")
  const [filter, setFilter] = useState<VersionFilter>("all")

  const rows = useMemo(
    () => joinVersionsWithDeployments(versions, deployments, resources),
    [versions, deployments, resources]
  )
  const counts = useMemo(() => countVersionsByStatus(versions), [versions])
  const visible = useMemo(() => filterVersionViews(rows, filter), [rows, filter])

  // Versions are append-only: one row per build, forever. Rendering all of them
  // is fine at ten and not at five hundred.
  const scrollRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    // A plain row; the failure blocks and production URL make some taller, which
    // `measureElement` corrects after paint.
    estimateSize: () => 88,
    overscan: 10,
    getItemKey: (index) => visible[index]?.version.id ?? index,
  })

  if (versions.length === 0) {
    return (
      <Empty role="status" className="gap-3 px-4 py-12">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="bg-primary/10 text-primary">
            <PackageIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle className="text-sm">{t("versions.title")}</EmptyTitle>
          <EmptyDescription className="max-w-[22rem] text-xs">
            {t("versions.empty")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-3" data-testid="site-versions-tab">
      <div className="shrink-0">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("versions.title")}
        </h3>
        <p className="text-xs text-muted-foreground">{t("versions.description")}</p>
      </div>

      <div className="shrink-0">
        <FilterChips
          filters={(["all", ...SITE_VERSION_STATUS_ORDER] as VersionFilter[]).map((key) => ({
            key,
            label: t(`versions.filter.${key}`),
            count: counts[key],
          }))}
          activeFilter={filter}
          onFilterChange={(key) => setFilter(key as VersionFilter)}
        />
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto rounded-xl border"
        data-testid="site-versions-list"
      >
        <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = visible[virtualRow.index]
            if (!row) return null
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <SiteVersionRow
                  row={row}
                  uploadGate={uploadGate}
                  deployGate={deployGate}
                  isBusy={isBusy}
                  onUpload={onUpload}
                  onDeploy={onDeploy}
                />
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
