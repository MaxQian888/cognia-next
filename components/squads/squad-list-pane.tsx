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
 * Rows are list rows, not cards. Each row used to be its own bordered,
 * raised `Surface`, which turned a list of names into a stack of boxes, put a
 * border between every name and the next, and spent a card's padding on two
 * lines of text. A list reads as one object; its rows separate by rhythm and
 * a hover/selected fill, the way the chat sidebar's rows do.
 *
 * Where the rows stand depends on what is behind them, which is why `variant`
 * exists:
 *  - `rail`: the desktop rail already paints its own ground (`bg-muted/20`
 *    under the shell's `aside`), so rows sit on it directly.
 *  - `page`: on a phone the list IS the page, over the wallpaper. There the
 *    rows share ONE grouped surface with hairlines between them, so they stay
 *    legible without becoming a card each.
 *
 * The narrowing toggles carry their own counts. A two-cell stat strip above
 * them repeated the same two numbers ("Needs you 1", "Working 2") one row
 * higher, and the toggle below was where the reader actually acted on them.
 *
 * The built-in Teams the chat sidebar offers as scopes are listed below the
 * Squads (`BuiltInTeamsSection`), so "No Squads yet" no longer sits next to a
 * sidebar full of squad-looking scopes with nothing explaining them. They are
 * not counted as Squads; the empty state points at them instead.
 */

import { useTranslations } from "next-intl"
import { SearchIcon } from "lucide-react"
import { AgentTeamAvatar } from "@/components/agent/workspace/agent-team-avatar"

import type { Team } from "@cognia/agent-config-types"
import { BuiltInTeamsSection } from "@/components/squads/built-in-teams"
import { EmptyState } from "@/components/mobile/empty-state"
import { ListSkeleton } from "@/components/mobile/discover/list-skeleton"
import { StatusBadge } from "@/components/status-badge"
import { Surface } from "@/components/surface/surface"
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
import { useUrlSearchDraft } from "@/hooks/ui/use-url-search-draft"
import { cn } from "@/lib/utils"

/** What the rows stand on. See the module doc. */
export type SquadListVariant = "rail" | "page"

export interface SquadListPaneProps {
  fleet: SquadFleetSnapshot
  route: SquadRouteState
  /**
   * Offered from the empty state. Absent when the host has nowhere to create
   * from, and on a host whose own header already carries "New Squad".
   */
  onCreate?: () => void
  /**
   * The built-in Teams (`useBuiltInTeams`). Listed in their own section and
   * never counted as Squads. Omit on a host that has no chat scopes to open.
   */
  builtInTeams?: readonly Team[]
  variant?: SquadListVariant
  /**
   * How an empty workspace is said. `full` is the illustrated empty state with
   * its call to action, right where the list is the whole page. `quiet` is one
   * muted line, for a rail whose neighbouring pane already shows the full
   * empty state: two "No Squads yet" panels side by side said it twice.
   */
  emptyStyle?: "full" | "quiet"
  className?: string
}

const NO_TEAMS: readonly Team[] = []

export function SquadListPane({
  fleet,
  route,
  onCreate,
  builtInTeams = NO_TEAMS,
  variant = "rail",
  emptyStyle = "full",
  className,
}: SquadListPaneProps) {
  const t = useTranslations("squads.fleet")
  const { squads, total, live, waiting, loading } = fleet

  // Its own draft, not the URL: see the hook for why a URL-bound box broke
  // IME input and dropped characters.
  const search = useUrlSearchDraft(route.query, route.setQuery)
  // A Team has no run state, so "Needs you" / "Working" cannot match one.
  const showBuiltIns = builtInTeams.length > 0 && route.filter === "all"
  const counts: Record<SquadFilter, number> = { all: total, waiting, live }

  const emptyDescription = route.narrowed
    ? t("noMatchesDescription")
    : builtInTeams.length > 0
      ? t("emptyDescriptionWithBuiltIns", { count: builtInTeams.length })
      : t("emptyDescription")

  const rows = squads.map((squad) => (
    <li key={squad.id}>
      <SquadRow
        squad={squad}
        selected={squad.id === route.selectedId}
        memberLabel={t("memberCount", { count: squad.memberCount })}
        waitingLabel={t("waiting")}
        onSelect={() => route.setSelectedId(squad.id === route.selectedId ? undefined : squad.id)}
      />
    </li>
  ))

  return (
    <div
      className={cn("@container/squad-list flex h-full min-h-0 flex-col", className)}
      data-testid="squad-fleet-rail"
      data-variant={variant}
    >
      {total > 0 ? (
        <div className="shrink-0 space-y-2 p-2">
          <div className="relative">
            <SearchIcon
              aria-hidden
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              {...search}
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
                // Label over count in a narrow rail, side by side once there is
                // room. Three labels and three counts on one line do not fit a
                // 230px rail, and it was the labels that gave way ("Nee… 0").
                className="h-auto min-h-8 flex-1 flex-col gap-0 px-1 py-1 text-[11px] leading-tight @[18rem]/squad-list:flex-row @[18rem]/squad-list:gap-1 @[18rem]/squad-list:py-0 @[18rem]/squad-list:text-xs"
                aria-label={t("filters.countAria", {
                  label: t(`filters.${option}`),
                  count: counts[option],
                })}
                data-testid={`squad-fleet-filter-${option}`}
              >
                <span className="max-w-full truncate">{t(`filters.${option}`)}</span>
                <span
                  aria-hidden
                  className={cn(
                    "tabular-nums text-muted-foreground",
                    option === "waiting" && counts.waiting > 0 && "font-semibold text-destructive",
                    option === "live" && counts.live > 0 && "text-emerald-600 dark:text-emerald-400"
                  )}
                  data-testid={`squad-fleet-filter-${option}-count`}
                >
                  {counts[option]}
                </span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      ) : null}

      {/* `!block` on the viewport's child: Radix wraps it in a `display:table`
          div that grows to its widest `truncate` line, so on a phone the empty
          state centred itself in a column wider than the screen and the
          built-in team rows ran off the right edge. Same override as
          `provider-sidebar.tsx` and `channel-list.tsx`. */}
      <ScrollArea
        className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block"
        data-testid="squad-fleet-scroll"
      >
        <div className={cn("space-y-3 p-2 pt-0", variant === "page" && "pb-4")}>
          {loading ? (
            <ListSkeleton rows={4} testId="squad-fleet-loading" />
          ) : squads.length === 0 ? (
            emptyStyle === "quiet" && !route.narrowed ? (
              <p
                className="px-2 py-3 text-xs text-muted-foreground"
                data-testid="squad-fleet-empty-quiet"
              >
                {t("emptyTitle")}
              </p>
            ) : (
              <EmptyState
                spotIcon="agent-teams"
                title={route.narrowed ? t("noMatchesTitle") : t("emptyTitle")}
                description={emptyDescription}
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
            )
          ) : variant === "page" ? (
            <Surface asChild layer="raised" radius="panel">
              <ul
                className="divide-y divide-border/60 overflow-hidden border"
                data-testid="squad-fleet-list"
              >
                {rows}
              </ul>
            </Surface>
          ) : (
            <ul className="space-y-0.5" data-testid="squad-fleet-list">
              {rows}
            </ul>
          )}
          {showBuiltIns ? (
            <BuiltInTeamsSection
              teams={builtInTeams}
              query={route.query}
              variant={variant}
              // Open while the workspace has no Squads of its own: then they
              // are the only thing here to use. Once there are Squads they
              // are a reference, folded under their heading.
              defaultOpen={total === 0}
            />
          ) : null}
        </div>
      </ScrollArea>
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
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      data-testid="squad-fleet-row"
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
        "hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-accent hover:bg-accent"
      )}
    >
      <span className="relative shrink-0">
        <AgentTeamAvatar subject={squad} className="size-9" />
        <span
          aria-hidden
          className={cn(
            "absolute bottom-0 right-0 size-2 rounded-full ring-2 ring-background",
            squad.waiting
              ? "bg-destructive"
              : squad.live
                ? "animate-pulse bg-emerald-500"
                : "bg-muted-foreground/40"
          )}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{squad.name}</span>
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
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {memberLabel}
          {squad.description ? ` · ${squad.description}` : ""}
        </span>
      </span>
    </button>
  )
}
