"use client"

/**
 * The console's Site rail.
 *
 * Each row answers "is this one live, busy, or broken" without selecting it,
 * which is why the console loads cross-Site deployment and operation signals
 * alongside the selected Site's own tables.
 */
import { useMemo, useState } from "react"
import { useTranslations, useFormatter, useNow } from "next-intl"
import { GlobeIcon, SearchIcon, XIcon } from "lucide-react"

import { FilterChips } from "@/components/scheduler/filter-chips"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { indexSiteRailHints, type SiteRailHint } from "@/lib/sites/console-model"
import { cn } from "@/lib/utils"
import type {
  SiteDeploymentRow,
  SiteLifecycle,
  SiteOperationRow,
  SiteProjectRow,
} from "@/types/sites"
import { SITE_LIFECYCLE_FACE, SiteStatusDot, SiteStatusPill } from "./site-status"

/** Only the two lifecycles a user browses by; `deleting`/`deleted` are transient. */
type LifecycleFilter = "all" | Extract<SiteLifecycle, "active" | "taken-down">

const LIFECYCLE_FILTERS: LifecycleFilter[] = ["all", "active", "taken-down"]

/** A row the index could not answer for — treated as never deployed. */
const NEVER_HINT: SiteRailHint = { kind: "never", tone: "neutral", live: false }

export interface SiteListRailProps {
  sites: readonly SiteProjectRow[]
  selectedId: string | null
  loading: boolean
  activeDeployments: readonly SiteDeploymentRow[]
  operationSignals: readonly SiteOperationRow[]
  onSelect: (siteId: string) => void
  /** Rendered in the rail footer — the console owns the creation dialog. */
  footer?: React.ReactNode
}

export function SiteListRail({
  sites,
  selectedId,
  loading,
  activeDeployments,
  operationSignals,
  onSelect,
  footer,
}: SiteListRailProps) {
  const t = useTranslations("sites")
  const format = useFormatter()
  const now = useNow()
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<LifecycleFilter>("all")

  const counts = useMemo(() => {
    const running = new Set(
      operationSignals
        .filter((operation) => operation.status === "queued" || operation.status === "running")
        .map((operation) => operation.siteId)
    )
    return {
      all: sites.length,
      active: sites.filter((site) => site.lifecycle === "active").length,
      "taken-down": sites.filter((site) => site.lifecycle === "taken-down").length,
      running: running.size,
    }
  }, [sites, operationSignals])

  // One pass over both signal lists instead of one filter per rendered row.
  const hints = useMemo(
    () => indexSiteRailHints(sites, activeDeployments, operationSignals),
    [sites, activeDeployments, operationSignals]
  )

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return sites.filter((site) => {
      if (filter !== "all" && site.lifecycle !== filter) return false
      if (!needle) return true
      return (
        site.name.toLowerCase().includes(needle) ||
        site.providerConfig.workerName.toLowerCase().includes(needle)
      )
    })
  }, [sites, query, filter])

  const hintText = (hint: SiteRailHint): string => {
    if (hint.kind === "running") return t("rail.running")
    if (hint.kind === "failed") return t("rail.hint.failed")
    if (hint.kind === "live") {
      return t("rail.hint.live", {
        when: hint.at ? format.relativeTime(new Date(hint.at), now) : "",
      })
    }
    return t("rail.hint.never")
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="site-rail">
      <div className="shrink-0 px-3 py-2">
        <InputGroup className="h-8">
          <InputGroupAddon align="inline-start">
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            className="text-sm"
            value={query}
            placeholder={t("rail.search")}
            aria-label={t("rail.search")}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                type="button"
                size="icon-xs"
                aria-label={t("rail.clear")}
                onClick={() => setQuery("")}
              >
                <XIcon aria-hidden />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>

      <div className="shrink-0">
        <FilterChips
          filters={LIFECYCLE_FILTERS.map((key) => ({
            key,
            label: key === "all" ? t("versions.filter.all") : t(`lifecycle.${key}`),
            count: counts[key],
          }))}
          activeFilter={filter}
          onFilterChange={(key) => setFilter(key as LifecycleFilter)}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2" data-testid="site-rail-list">
        {loading ? (
          <div className="space-y-2 px-3">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : sites.length === 0 ? (
          <Empty role="status" className="gap-3 px-4 py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="bg-primary/10 text-primary">
                <GlobeIcon aria-hidden />
              </EmptyMedia>
              <EmptyTitle className="text-sm">{t("title")}</EmptyTitle>
              <EmptyDescription className="max-w-[16rem] text-xs">
                {t("sidebarEmpty")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            {t("rail.noMatches")}
          </p>
        ) : (
          <ul>
            {rows.map((site) => {
              const hint = hints.get(site.id) ?? NEVER_HINT
              const selected = site.id === selectedId
              return (
                <li key={site.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(site.id)}
                    aria-current={selected || undefined}
                    data-testid={`site-rail-row-${site.id}`}
                    className={cn(
                      "group flex w-full items-start gap-2 px-3 py-2 text-left transition-colors duration-200 motion-reduce:transition-none",
                      "hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      selected && "border-l-2 border-primary bg-accent pl-[10px]",
                      site.lifecycle === "deleted" && "opacity-60"
                    )}
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
                        {site.providerConfig.workerName}
                      </span>
                      <span
                        className={cn(
                          "block truncate text-xs text-muted-foreground",
                          hint.tone === "danger" && "text-destructive"
                        )}
                      >
                        {hintText(hint)}
                      </span>
                    </span>
                    <SiteStatusDot tone={hint.tone} live={hint.live} className="mt-2" />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <Separator />
      <div className="grid shrink-0 grid-cols-3 gap-1 px-3 py-2 text-center">
        <div>
          <p className="text-xs font-semibold tabular-nums text-success">{counts.active}</p>
          <p className="text-[10px] text-muted-foreground">{t("lifecycle.active")}</p>
        </div>
        <div>
          <p className="text-xs font-semibold tabular-nums text-warning">{counts["taken-down"]}</p>
          <p className="text-[10px] text-muted-foreground">{t("lifecycle.taken-down")}</p>
        </div>
        <div>
          <p className="text-xs font-semibold tabular-nums text-info">{counts.running}</p>
          <p className="text-[10px] text-muted-foreground">{t("rail.running")}</p>
        </div>
      </div>
      {footer ? <div className="shrink-0 p-3 pt-0">{footer}</div> : null}
    </div>
  )
}
