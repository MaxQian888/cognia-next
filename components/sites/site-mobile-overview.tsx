"use client"

/**
 * What a phone can honestly say about Sites.
 *
 * ADR-0084 defers the mobile projection until the sync table, delta reader,
 * and tombstones exist, and that deferral stands — nothing here reaches
 * another host. But the ADR's last paragraph also says the console renders in
 * every shell over whichever local database that shell owns, and the previous
 * screen ignored the second half: a single "desktop only" alert, with no
 * indication of whether this device knows about any Sites at all.
 *
 * So this reads the phone's own Dexie. When it holds Sites (a shared profile,
 * a restored backup), they are listed read-only with their lifecycle and live
 * URL. When it holds none — the common case — it says why and where the Sites
 * actually live, rather than leaving the reader to guess whether the feature
 * is missing, broken, or simply elsewhere.
 */
import { useTranslations } from "next-intl"
import { CloudIcon, GlobeIcon } from "lucide-react"

import { Surface } from "@/components/surface/surface"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { siteProductionUrl } from "@/lib/sites/console-model"
import { cn } from "@/lib/utils"
import { SITE_LIFECYCLE_FACE, SiteStatusPill } from "./site-status"
import type { SiteDeploymentRow, SiteProjectRow } from "@/types/sites"

export interface SiteMobileOverviewProps {
  sites: readonly SiteProjectRow[]
  activeDeployments: readonly SiteDeploymentRow[]
  loading: boolean
}

export function SiteMobileOverview({ sites, activeDeployments, loading }: SiteMobileOverviewProps) {
  const t = useTranslations("sites")

  return (
    <div className="space-y-4 p-4" data-testid="sites-mobile-notice">
      <Alert>
        <CloudIcon />
        <AlertTitle>{t("mobile.readOnly")}</AlertTitle>
        <AlertDescription>{t("mobile.explain")}</AlertDescription>
      </Alert>

      {loading ? (
        <div className="space-y-2" data-testid="sites-mobile-loading">
          <Skeleton className="h-14 w-full rounded-panel" />
          <Skeleton className="h-14 w-full rounded-panel" />
        </div>
      ) : sites.length === 0 ? (
        <Empty role="status" className="gap-3 px-4 py-10" data-testid="sites-mobile-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="bg-primary/10 text-primary">
              <GlobeIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle className="text-sm">{t("mobile.empty")}</EmptyTitle>
            <EmptyDescription className="max-w-sm text-xs">
              {t("mobile.emptyExplain")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="space-y-2" data-testid="sites-mobile-list">
          {sites.map((site) => {
            const url = siteProductionUrl(activeDeployments.filter((row) => row.siteId === site.id))
            return (
              <li key={site.id}>
                <Surface
                  layer="raised"
                  radius="panel"
                  className={cn(
                    "flex items-start gap-2 border p-3",
                    site.lifecycle === "deleted" && "opacity-60"
                  )}
                  data-testid={`sites-mobile-row-${site.id}`}
                >
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded bg-primary/10 text-primary">
                    <GlobeIcon aria-hidden className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {site.name}
                      </span>
                      <SiteStatusPill
                        face={SITE_LIFECYCLE_FACE[site.lifecycle]}
                        label={t(`lifecycle.${site.lifecycle}`)}
                        className="shrink-0 px-1.5 text-[10px]"
                      />
                    </span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {url ?? site.providerConfig.workerName}
                    </span>
                  </span>
                </Surface>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
