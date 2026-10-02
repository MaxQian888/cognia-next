"use client"

/**
 * The public `/status` page for the official hosted Cognia relay.
 *
 * One static export serves three runtimes (see `lib/status/config.ts`): the
 * primary page on the status Worker, a read-only mirror, and the route inside
 * Cognia itself. The page renders a skeleton until the runtime resolves on
 * the client, then shows only validated live data from the status API.
 * There is no preview or fallback dataset: without a snapshot the status is
 * "unknown". Plan: docs/plans/2026-10-02-signaling-public-status-implementation.md §11.
 */

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ActivityIcon, BellIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useIncidentDetail } from "@/hooks/status/use-incident-detail"
import { useIncidentPages } from "@/hooks/status/use-incident-pages"
import { usePublicStatus } from "@/hooks/status/use-public-status"
import { useStatusRuntime } from "@/hooks/status/use-status-runtime"
import { useTokenAction } from "@/hooks/status/use-subscription-actions"
import type { StatusRuntime } from "@/lib/status/public-status"
import { openExternal } from "@/lib/tauri/opener"

import { ComponentRow } from "./component-row"
import { HistoryLegend } from "./history-strip"
import { IncidentDetailDialog } from "./incident-detail-dialog"
import { ActiveIncidents, PastIncidents } from "./incident-section"
import { MaintenanceSection } from "./maintenance-section"
import { MonitoringSection } from "./monitoring-section"
import { StatusFooter } from "./status-footer"
import { StatusHero } from "./status-hero"
import { SectionHeading, StatusPanel } from "./status-labels"
import { MirrorNotice, RefreshErrorBanner } from "./status-notices"
import { SubscriptionDialog } from "./subscription-dialog"
import { TokenActionDialog } from "./token-action-dialog"

const EMPTY: never[] = []

function StatusHeader({ onSubscribe }: { onSubscribe: (() => void) | null }) {
  const t = useTranslations("publicStatus")
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/88 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <a
          href="#top"
          className="group flex min-w-0 items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-foreground text-xs font-semibold text-background transition-transform duration-200 group-hover:-rotate-3 motion-reduce:transition-none">
            {t("brandMark")}
          </span>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="font-semibold tracking-tight">{t("brand")}</span>
            <span className="hidden truncate text-sm text-muted-foreground sm:inline">
              {t("nav.systemStatus")}
            </span>
          </span>
        </a>
        <nav className="flex items-center gap-1" aria-label={t("nav.systemStatus")}>
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <a href="#components">{t("nav.components")}</a>
          </Button>
          <Button asChild variant="ghost" size="sm" className="hidden md:inline-flex">
            <a href="#history">{t("nav.history")}</a>
          </Button>
          <Button asChild variant="ghost" size="sm" className="hidden md:inline-flex">
            <a href="#monitoring">{t("nav.monitoring")}</a>
          </Button>
          {onSubscribe ? (
            <Button size="sm" onClick={onSubscribe}>
              <BellIcon aria-hidden />
              {t("nav.subscribe")}
            </Button>
          ) : null}
        </nav>
      </div>
    </header>
  )
}

function PageFrame({
  onSubscribe,
  children,
}: {
  onSubscribe: (() => void) | null
  children: ReactNode
}) {
  return (
    <main className="relative min-h-dvh w-full max-w-full overflow-x-hidden bg-background text-foreground">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[44rem] bg-[radial-gradient(circle_at_78%_4%,color-mix(in_oklch,var(--primary)_8%,transparent),transparent_43%),radial-gradient(circle_at_8%_18%,color-mix(in_oklch,var(--chart-2)_9%,transparent),transparent_38%)]"
      />
      <StatusHeader onSubscribe={onSubscribe} />
      <div id="top" className="relative mx-auto max-w-6xl px-4 sm:px-6">
        {children}
      </div>
    </main>
  )
}

/** Server-rendered and pre-hydration shape: chrome plus placeholders only. */
function StatusPageSkeleton() {
  return (
    <PageFrame onSubscribe={null}>
      <div className="space-y-6 border-b py-14 md:py-24" data-testid="status-skeleton">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-16 w-full max-w-2xl" />
        <Skeleton className="h-11 w-64 rounded-pill" />
      </div>
      <div className="space-y-4 py-14">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </PageFrame>
  )
}

function LiveStatusPage({ runtime }: { runtime: StatusRuntime }) {
  const t = useTranslations("publicStatus")
  const status = usePublicStatus(runtime)
  const detail = useIncidentDetail(runtime)
  const token = useTokenAction(runtime)
  const [subscribeOpen, setSubscribeOpen] = useState(false)

  const snapshot = status.loaded?.snapshot ?? null
  const stale = status.freshness?.stale ?? false
  const pages = useIncidentPages(runtime, {
    past: snapshot?.pastIncidents ?? EMPTY,
    active: snapshot?.activeIncidents ?? EMPTY,
  })

  // Inside Cognia the consent flow runs on the official page in the browser;
  // this origin never posts subscription writes.
  const onSubscribe =
    runtime.mode === "app"
      ? () => void openExternal(runtime.primaryPageUrl)
      : () => setSubscribeOpen(true)

  return (
    <PageFrame onSubscribe={onSubscribe}>
      {runtime.mode === "mirror" ? (
        <div className="pt-6">
          <MirrorNotice runtime={runtime} />
        </div>
      ) : null}
      {status.error && status.loaded ? (
        <div className="pt-6">
          <RefreshErrorBanner
            error={status.error}
            fetchedAtClientMs={status.loaded.fetchedAtClientMs}
            onRetry={status.refresh}
            refreshing={status.refreshing}
          />
        </div>
      ) : null}

      <StatusHero
        snapshot={snapshot}
        freshness={status.freshness}
        range={status.range}
        ranges={status.availableRanges}
        onRangeChange={status.setRange}
        pendingRange={status.pendingRange}
        failure={snapshot ? null : status.error}
        onRetry={status.refresh}
        refreshing={status.refreshing}
      />

      {snapshot ? (
        <>
          <section
            id="components"
            aria-labelledby="components-title"
            className="scroll-mt-24 py-12 md:py-16"
          >
            <SectionHeading
              id="components-title"
              icon={ActivityIcon}
              title={t("sections.componentsTitle")}
              description={t("sections.componentsDescription")}
            />
            <StatusPanel className="mt-8">
              <div className="divide-y">
                {snapshot.components.map((component) => (
                  <ComponentRow
                    key={component.id}
                    component={component}
                    range={snapshot.range}
                    probes={snapshot.probes}
                    stale={stale}
                  />
                ))}
              </div>
              <div className="border-t bg-muted/30 px-5 py-3.5 sm:px-6">
                <HistoryLegend />
              </div>
            </StatusPanel>
          </section>

          <section className="grid grid-cols-1 gap-6 pb-12 md:grid-cols-12 md:pb-16 lg:gap-8">
            <div className="min-w-0 md:col-span-7">
              <ActiveIncidents incidents={snapshot.activeIncidents} onOpen={detail.open} />
            </div>
            <aside className="min-w-0 md:col-span-5">
              <MaintenanceSection maintenance={snapshot.scheduledMaintenance} />
            </aside>
          </section>

          <PastIncidents pages={pages} onOpen={detail.open} />

          <MonitoringSection
            probes={snapshot.probes}
            monitoringStatus={snapshot.monitoringStatus}
          />
        </>
      ) : null}

      <StatusFooter
        runtime={runtime}
        capabilities={snapshot?.capabilities ?? null}
        onSubscribe={onSubscribe}
      />

      {runtime.mode !== "app" ? (
        <SubscriptionDialog
          open={subscribeOpen}
          onOpenChange={setSubscribeOpen}
          runtime={runtime}
          capabilities={snapshot?.capabilities ?? null}
        />
      ) : null}
      <IncidentDetailDialog state={detail} />
      <TokenActionDialog runtime={runtime} token={token} />
    </PageFrame>
  )
}

export function PublicStatusPage() {
  const runtime = useStatusRuntime()
  if (!runtime) return <StatusPageSkeleton />
  return <LiveStatusPage runtime={runtime} />
}
