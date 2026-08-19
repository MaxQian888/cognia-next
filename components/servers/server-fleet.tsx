"use client"

/**
 * The fleet list — one row per deployment target, opening the detail route.
 *
 * A list-then-detail pair rather than the old resizable split: every row's
 * columns collapse independently at each breakpoint, so the same markup serves
 * desktop and mobile instead of the workspace carrying two parallel trees.
 */

import { useMemo } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import {
  BoxesIcon,
  ChevronRightIcon,
  ContainerIcon,
  PlugZapIcon,
  ServerIcon,
  ShieldCheckIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { Operation, ServerDetail, ServerHealth } from "@/lib/server-ops/client"
import { isTerminalOperation } from "@/lib/server-ops/operation-stream"
import { cn } from "@/lib/utils"
import {
  HealthDot,
  HealthLabel,
  SERVER_HEALTHS,
  shortenDigest,
  useRelativeTime,
} from "./server-visuals"

export type FleetFilter = ServerHealth | "all"

export function serverDetailHref(id: string): string {
  return `/servers/detail?id=${encodeURIComponent(id)}`
}

function Kpi({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: number
  icon: typeof ServerIcon
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted">
        <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block text-lg leading-none font-semibold tabular-nums">{value}</span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">{label}</span>
      </span>
    </div>
  )
}

function FleetRow({
  server,
  activeOperations,
}: {
  server: ServerDetail
  activeOperations: number
}) {
  const t = useTranslations("servers")
  const relative = useRelativeTime()
  const digest = shortenDigest(server.releaseDigest)

  return (
    <Link
      href={serverDetailHref(server.id)}
      data-testid={`server-row-${server.id}`}
      className="group flex min-w-0 items-center gap-3 px-4 py-3.5 transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
    >
      <span className="relative grid size-10 shrink-0 place-items-center rounded-lg border bg-background">
        <ContainerIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        <HealthDot
          health={server.health}
          className="absolute -right-0.5 -bottom-0.5 ring-2 ring-background"
        />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{server.label || server.id}</span>
        <span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">{t(`topology.${server.topology}` as "topology.compose")}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate font-mono">{server.id}</span>
        </span>
      </span>

      <span className="hidden w-32 shrink-0 md:block">
        <HealthLabel health={server.health} />
      </span>

      <span className="hidden w-40 shrink-0 lg:block">
        {server.productionCertified ? (
          <Badge variant="outline" className="gap-1 font-normal">
            <ShieldCheckIcon className="size-3" aria-hidden="true" />
            {t("certified")}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">{t("notCertified")}</span>
        )}
      </span>

      <span className="hidden w-44 shrink-0 truncate font-mono text-xs text-muted-foreground xl:block">
        {digest ?? t("notAvailable")}
      </span>

      <span className="hidden w-32 shrink-0 text-right text-xs text-muted-foreground lg:block">
        {activeOperations > 0
          ? t("fleet.activeOperations", { count: activeOperations })
          : relative(server.lastSeenAt)}
      </span>

      <ChevronRightIcon
        className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground"
        aria-hidden="true"
      />
    </Link>
  )
}

export function ServerFleet({
  servers,
  operations,
  loading,
  filter,
  onFilterChange,
  onConnectAgent,
  onDeploy,
}: {
  servers: readonly ServerDetail[]
  operations: readonly Operation[]
  loading: boolean
  filter: FleetFilter
  onFilterChange: (filter: FleetFilter) => void
  onConnectAgent: () => void
  onDeploy: () => void
}) {
  const t = useTranslations("servers")

  const activeByTarget = useMemo(() => {
    const counts = new Map<string, number>()
    for (const operation of operations) {
      if (isTerminalOperation(operation)) continue
      counts.set(operation.targetId, (counts.get(operation.targetId) ?? 0) + 1)
    }
    return counts
  }, [operations])

  const filtered = useMemo(
    () => (filter === "all" ? servers : servers.filter((server) => server.health === filter)),
    [filter, servers]
  )

  const healthy = servers.filter((server) => server.health === "healthy").length
  const certified = servers.filter((server) => server.productionCertified).length
  const active = operations.filter((operation) => !isTerminalOperation(operation)).length

  if (loading && servers.length === 0) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-14 rounded-lg" />
          ))}
        </div>
        <div className="overflow-hidden rounded-lg border">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex items-center gap-3 border-b p-4 last:border-b-0">
              <Skeleton className="size-10 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 p-4 md:p-6">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi label={t("kpi.total")} value={servers.length} icon={ServerIcon} />
          <Kpi label={t("kpi.healthy")} value={healthy} icon={ShieldCheckIcon} />
          <Kpi label={t("kpi.certified")} value={certified} icon={ContainerIcon} />
          <Kpi label={t("kpi.operations")} value={active} icon={BoxesIcon} />
        </div>

        {servers.length === 0 ? (
          <Empty className="rounded-lg border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ServerIcon />
              </EmptyMedia>
              <EmptyTitle>{t("fleet.emptyTitle")}</EmptyTitle>
              <EmptyDescription>{t("fleet.emptyDescription")}</EmptyDescription>
            </EmptyHeader>
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" onClick={onDeploy}>
                {t("actions.deploy")}
              </Button>
              <Button size="sm" variant="outline" onClick={onConnectAgent}>
                <PlugZapIcon className="size-4" aria-hidden="true" />
                {t("enroll.action")}
              </Button>
            </div>
          </Empty>
        ) : (
          <>
            <ToggleGroup
              type="single"
              value={filter}
              onValueChange={(value) => value && onFilterChange(value as FleetFilter)}
              variant="outline"
              size="sm"
              className="w-fit"
              aria-label={t("filters.title")}
            >
              <ToggleGroupItem value="all">{t("filters.all")}</ToggleGroupItem>
              {SERVER_HEALTHS.map((health) => (
                <ToggleGroupItem key={health} value={health} className="gap-1.5">
                  <HealthDot health={health} />
                  {t(`health.${health}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>

            {filtered.length === 0 ? (
              <Empty className="rounded-lg border">
                <EmptyHeader>
                  <EmptyTitle>{t("fleet.noMatchTitle")}</EmptyTitle>
                  <EmptyDescription>{t("fleet.noMatchDescription")}</EmptyDescription>
                </EmptyHeader>
                <Button size="sm" variant="outline" onClick={() => onFilterChange("all")}>
                  {t("filters.all")}
                </Button>
              </Empty>
            ) : (
              <div
                className={cn("overflow-hidden rounded-lg border bg-card", loading && "opacity-70")}
              >
                <div className="divide-y">
                  {filtered.map((server) => (
                    <FleetRow
                      key={server.id}
                      server={server}
                      activeOperations={activeByTarget.get(server.id) ?? 0}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </ScrollArea>
  )
}
