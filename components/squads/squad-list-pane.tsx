"use client"

/**
 * The Squad list, written once for the desktop rail and the phone.
 *
 * The console's rail and a phone body answer the same question with the same
 * rows, so they are the same component. It takes props rather than reading the
 * store, so both hosts test it identically and neither can drift into a
 * different sort or a different badge. Same shape as
 * `components/devices/device-list-pane.tsx`, shared verbatim by `/devices`
 * desktop and mobile.
 *
 * Three things here are corrections rather than additions.
 *
 * The rows are `Surface` cards. They were a hand-rolled `<button>` carrying
 * `role="listitem"` inside a plain `<div role="list">`, which is not a list to
 * a screen reader (a button cannot be a listitem) and is invisible to the
 * ADR-0148 tier system, so on a wallpaper the rows had no ground of their own.
 *
 * The masthead carries the waiting count. The page computed it, sorted by it,
 * and never showed it, which made the single most actionable number on the
 * screen something you had to infer from badge colours.
 *
 * And an empty list offers a way out. It used to say Squads are made in
 * Settings and leave you to go find Settings.
 */

import { useTranslations } from "next-intl"
import { PlusIcon, SearchIcon, UsersIcon } from "lucide-react"

import { EmptyState } from "@/components/mobile/empty-state"
import { ListSkeleton } from "@/components/mobile/discover/list-skeleton"
import { StatusBadge } from "@/components/status-badge"
import { Surface } from "@/components/surface/surface"
import { StatStrip, type StatStripItem } from "@/components/surface/stat-strip"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { SquadFleetRow, SquadFleetSnapshot } from "@/hooks/squads/use-squad-fleet"
import {
  SQUAD_FILTERS,
  type SquadFilter,
  type SquadRouteState,
} from "@/hooks/squads/use-squad-route-state"
import { cn } from "@/lib/utils"

export interface SquadListPaneProps {
  fleet: SquadFleetSnapshot
  route: SquadRouteState
  /** Absent when the host has nowhere to create from. The CTA is then omitted. */
  onCreate?: () => void
  className?: string
}

export function SquadListPane({ fleet, route, onCreate, className }: SquadListPaneProps) {
  const t = useTranslations("squads.fleet")
  const { squads, total, live, waiting, loading } = fleet

  // Two cells, not three. `STAT_COLUMNS` gives two an unconditional
  // `grid-cols-2`, which is right in a 300px rail AND full width on a phone.
  // Three would collapse into a tall stack in the rail, where this strip
  // spends most of its life.
  const stats: StatStripItem[] = [
    {
      id: "waiting",
      label: t("stats.waiting"),
      value: waiting,
      tone: waiting > 0 ? "attention" : "neutral",
    },
    {
      id: "working",
      label: t("stats.working"),
      value: live,
      total,
      tone: live > 0 ? "positive" : "neutral",
    },
  ]

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)} data-testid="squad-fleet-rail">
      {total > 0 ? (
        <div className="shrink-0 space-y-2 p-2">
          <StatStrip stats={stats} testId="squad-fleet-stats" />
          <div className="relative">
            <SearchIcon
              aria-hidden
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={route.query}
              onChange={(event) => route.setQuery(event.target.value)}
              placeholder={t("search")}
              aria-label={t("search")}
              className="pl-9"
              data-testid="squad-fleet-search"
            />
          </div>
          {/* Inline, not a filter sheet. `/templates` earned a sheet because it
              has three facets. One three-way toggle behind a button would be
              chrome guarding chrome. */}
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={route.filter}
            onValueChange={(next) => route.setFilter((next || "all") as SquadFilter)}
            className="w-full"
            aria-label={t("filters.label")}
          >
            {SQUAD_FILTERS.map((option) => (
              <ToggleGroupItem
                key={option}
                value={option}
                className="flex-1 text-xs"
                data-testid={`squad-fleet-filter-${option}`}
              >
                {t(`filters.${option}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1.5 p-2 pt-0">
          {loading ? (
            <ListSkeleton rows={4} testId="squad-fleet-loading" />
          ) : squads.length === 0 ? (
            <EmptyState
              icon={UsersIcon}
              title={route.narrowed ? t("noMatchesTitle") : t("emptyTitle")}
              description={route.narrowed ? t("noMatchesDescription") : t("emptyDescription")}
              {...(route.narrowed
                ? { cta: { label: t("clearFilters"), onSelect: route.clearFilters } }
                : onCreate
                  ? {
                      cta: {
                        label: t("createCta"),
                        onSelect: onCreate,
                        testId: "squad-fleet-create",
                      },
                    }
                  : {})}
              className="border-0 bg-transparent"
            />
          ) : (
            <ul className="space-y-1.5" data-testid="squad-fleet-list">
              {squads.map((squad) => (
                <li key={squad.id}>
                  <SquadRow
                    squad={squad}
                    selected={squad.id === route.selectedId}
                    memberLabel={t("memberCount", { count: squad.memberCount })}
                    waitingLabel={t("waiting")}
                    onSelect={() =>
                      route.setSelectedId(squad.id === route.selectedId ? undefined : squad.id)
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </ScrollArea>

      {/* A control that is simply absent reads as a bug, so the CTA stays
          visible once there are rows for it to sit under. */}
      {onCreate && !loading && squads.length > 0 ? (
        <div className="shrink-0 border-t p-2">
          <button
            type="button"
            onClick={onCreate}
            className="flex w-full items-center justify-center gap-1.5 rounded-sm py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid="squad-fleet-create"
          >
            <PlusIcon aria-hidden className="size-3.5" />
            {t("createCta")}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function SquadRow({
  squad,
  selected,
  memberLabel,
  waitingLabel,
  onSelect,
}: {
  squad: SquadFleetRow
  selected: boolean
  memberLabel: string
  waitingLabel: string
  onSelect: () => void
}) {
  return (
    <Surface asChild layer="raised" radius="control">
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        data-testid="squad-fleet-row"
        className={cn(
          "w-full border p-2.5 text-left hover:bg-accent",
          selected && "bg-accent ring-1 ring-ring"
        )}
      >
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              squad.live ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/40"
            )}
          />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{squad.name}</span>
          {squad.waiting ? (
            <Badge
              variant="destructive"
              className="shrink-0 text-[10px]"
              data-testid="squad-fleet-waiting"
            >
              {waitingLabel}
            </Badge>
          ) : (
            <StatusBadge
              value={squad.status}
              labelNamespace="agentTeam.status"
              className="shrink-0 text-[10px]"
              pulse={squad.live}
            />
          )}
        </span>
        <span className="mt-0.5 block truncate pl-4 text-[10px] text-muted-foreground">
          {memberLabel}
        </span>
      </button>
    </Surface>
  )
}
