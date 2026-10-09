"use client"

/**
 * Every agent, written once for the desktop rail and the phone (ADR-0220).
 *
 * The same shape as the Squad rail (`components/squads/squad-list-pane.tsx`):
 * a search box, the source chips that carry their own counts, then the agents
 * as list rows rather than cards or table rows. A row says who the agent is
 * and, only when there is something to say, that it is working or waiting on
 * you; everything else about it is one click away in its detail.
 *
 * Batch work (export, delete) is a mode of the list, not a second list: "Select"
 * turns the rows into checkboxes and puts the batch bar at the foot of the
 * rail, where it never covers a row.
 *
 * `variant` is what the rows stand on, as in the Squad list: `rail` sits on the
 * shell's own aside ground, `page` is a phone, where the list is the page and
 * the rows share one grouped surface.
 */

import { useMemo, useState } from "react"
import { useFormatter, useLocale, useNow, useTranslations } from "next-intl"
import {
  ArrowDownUpIcon,
  CheckIcon,
  DownloadIcon,
  ListChecksIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react"
import type { Character } from "@cognia/agent-config-types"
import { EmptyState } from "@/components/mobile/empty-state"
import { ListSkeleton } from "@/components/mobile/discover/list-skeleton"
import { Surface } from "@/components/surface/surface"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useAgentActions } from "@/hooks/agents/use-agent-actions"
import {
  AGENT_SORTS,
  AGENT_SOURCE_FILTERS,
  type AgentSort,
  type AgentSourceFilter,
} from "@/hooks/agents/use-agents-route-state"
import { useUrlSearchDraft } from "@/hooks/ui/use-url-search-draft"
import type { AgentSummary } from "@/lib/agents/agent-activity"
import { sortAgents } from "@/lib/agents/agent-list"
import { describeAgentSource } from "@/lib/agents/agent-source"
import {
  classifyCharacterSource,
  filterCharacters,
} from "@/lib/plugin/character-pack/editor-projection"
import { cn } from "@/lib/utils"
import { AgentAvatar } from "./agent-visuals"

export type AgentListVariant = "rail" | "page"

export interface AgentListPaneProps {
  /** `undefined` while the first read is in flight. */
  agents: readonly Character[] | undefined
  summaries: ReadonlyMap<string, AgentSummary>
  selectedId?: string
  query: string
  source: AgentSourceFilter
  sort: AgentSort
  onQueryChange: (value: string) => void
  onSourceChange: (value: AgentSourceFilter) => void
  onSortChange: (value: AgentSort) => void
  onSelect: (id: string) => void
  /** Offered from the empty state. */
  onCreate?: () => void
  variant?: AgentListVariant
  className?: string
}

export function AgentListPane({
  agents,
  summaries,
  selectedId,
  query,
  source,
  sort,
  onQueryChange,
  onSourceChange,
  onSortChange,
  onSelect,
  onCreate,
  variant = "rail",
  className,
}: AgentListPaneProps) {
  const t = useTranslations("agentsConsole.listPane")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const locale = useLocale()
  const actions = useAgentActions()
  // Its own draft, not the URL: a URL-bound box drops characters and breaks
  // IME input (see the hook).
  const search = useUrlSearchDraft(query, onQueryChange)
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)

  const all = useMemo(() => agents ?? [], [agents])
  const counts = useMemo(() => {
    const out: Record<AgentSourceFilter, number> = {
      all: all.length,
      user: 0,
      builtin: 0,
      plugin: 0,
    }
    for (const agent of all) out[classifyCharacterSource(agent)] += 1
    return out
  }, [all])
  const rows = useMemo(
    () => sortAgents(filterCharacters(all, query, source), sort, summaries, locale),
    [all, query, source, sort, summaries, locale]
  )
  const chosen = useMemo(() => all.filter((agent) => picked.has(agent.id)), [all, picked])
  const narrowed = query.trim() !== "" || source !== "all"

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const exitSelection = () => {
    setSelecting(false)
    setPicked(new Set())
  }
  const allVisiblePicked = rows.length > 0 && rows.every((row) => picked.has(row.id))

  const list = rows.map((agent) => {
    const summary = summaries.get(agent.id)
    const status = summary?.status ?? "idle"
    const agentSource = describeAgentSource(agent)
    const flagged = agentSource.updateAvailable || agentSource.warnings.length > 0
    return (
      <li key={agent.id}>
        <button
          type="button"
          onClick={() => (selecting ? toggle(agent.id) : onSelect(agent.id))}
          aria-current={!selecting && agent.id === selectedId ? "true" : undefined}
          aria-pressed={selecting ? picked.has(agent.id) : undefined}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
            "hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            variant === "page" && "rounded-none px-3 py-2.5",
            !selecting && agent.id === selectedId && "bg-accent hover:bg-accent"
          )}
          data-testid="agent-list-row"
          data-agent-id={agent.id}
        >
          {selecting ? (
            <Checkbox
              checked={picked.has(agent.id)}
              tabIndex={-1}
              aria-hidden
              className="pointer-events-none shrink-0"
            />
          ) : null}
          <AgentAvatar agent={agent} size={36} status={status} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{agent.name}</span>
              {status !== "idle" ? (
                <span
                  className={cn(
                    "shrink-0 text-[11px]",
                    status === "running"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-amber-600 dark:text-amber-400"
                  )}
                  data-testid="agent-list-status"
                >
                  {t(`status.${status}`)}
                </span>
              ) : agent.isBuiltIn ? (
                <Badge variant="secondary" className="shrink-0 px-1.5 text-[10px] font-normal">
                  {t("builtIn")}
                </Badge>
              ) : null}
              {flagged ? (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-amber-500"
                  title={agentSource.updateAvailable ? t("updateAvailable") : t("needsAttention")}
                  data-testid="agent-list-flag"
                />
              ) : null}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {agent.description?.trim() ||
                (summary?.lastActiveAt
                  ? t("lastActive", {
                      when: format.relativeTime(new Date(summary.lastActiveAt), now),
                    })
                  : t("neverActive"))}
            </span>
          </span>
        </button>
      </li>
    )
  })

  return (
    <div
      className={cn("@container/agent-list flex h-full min-h-0 flex-col", className)}
      data-testid="agent-list-pane"
      data-variant={variant}
    >
      {all.length > 0 ? (
        <div className="shrink-0 space-y-2 p-2">
          <div className="flex items-center gap-1">
            <div className="relative min-w-0 flex-1">
              <SearchIcon
                aria-hidden
                className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                {...search}
                placeholder={t("searchPlaceholder")}
                aria-label={t("searchPlaceholder")}
                className="pl-9"
                data-testid="agent-list-search"
              />
            </div>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-9 shrink-0 text-muted-foreground"
                      aria-label={t("sortLabel")}
                      data-testid="agent-list-sort"
                    >
                      <ArrowDownUpIcon className="size-4" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>{t("sortLabel")}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  {t("sortLabel")}
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={sort}
                  onValueChange={(value) => onSortChange(value as AgentSort)}
                >
                  {AGENT_SORTS.map((value) => (
                    <DropdownMenuRadioItem
                      key={value}
                      value={value}
                      data-testid={`agent-list-sort-${value}`}
                    >
                      {t(`sort.${value}`)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={selecting ? "secondary" : "ghost"}
                  size="icon"
                  className={cn("size-9 shrink-0", !selecting && "text-muted-foreground")}
                  onClick={() => (selecting ? exitSelection() : setSelecting(true))}
                  aria-label={selecting ? t("bulk.done") : t("bulk.select")}
                  aria-pressed={selecting}
                  data-testid="agent-list-select"
                >
                  {selecting ? (
                    <CheckIcon className="size-4" aria-hidden />
                  ) : (
                    <ListChecksIcon className="size-4" aria-hidden />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{selecting ? t("bulk.done") : t("bulk.select")}</TooltipContent>
            </Tooltip>
          </div>
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={source}
            onValueChange={(next) => onSourceChange((next || "all") as AgentSourceFilter)}
            className="w-full"
            aria-label={t("sourceLabel")}
          >
            {AGENT_SOURCE_FILTERS.map((value) => (
              <ToggleGroupItem
                key={value}
                value={value}
                // Label over count in a narrow rail, side by side once there is
                // room, as in the Squad rail.
                className="h-auto min-h-8 flex-1 flex-col gap-0 px-1 py-1 text-[11px] leading-tight @[18rem]/agent-list:flex-row @[18rem]/agent-list:gap-1 @[18rem]/agent-list:py-0 @[18rem]/agent-list:text-xs"
                aria-label={t("sourceCountAria", {
                  label: t(`source.${value}`),
                  count: counts[value],
                })}
                data-testid={`agent-list-source-${value}`}
              >
                <span className="max-w-full truncate">{t(`source.${value}`)}</span>
                <span aria-hidden className="tabular-nums text-muted-foreground">
                  {counts[value]}
                </span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {selecting ? (
            <label className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
              <Checkbox
                checked={allVisiblePicked}
                onCheckedChange={(checked) =>
                  setPicked(checked ? new Set(rows.map((row) => row.id)) : new Set())
                }
                data-testid="agent-list-select-all"
              />
              {t("bulk.selectAll")}
            </label>
          ) : null}
        </div>
      ) : null}

      {/* `!block` on the viewport's child: Radix wraps it in a `display:table`
          div that grows to its widest `truncate` line. Same override as the
          Squad rail. */}
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <nav className={cn("p-2 pt-0", variant === "page" && "pb-4")} aria-label={t("label")}>
          {agents === undefined ? (
            <ListSkeleton rows={5} testId="agent-list-loading" />
          ) : all.length === 0 ? (
            <EmptyState
              spotIcon="characters"
              title={t("emptyTitle")}
              description={t("emptyDescription")}
              {...(onCreate
                ? { cta: { label: t("create"), onSelect: onCreate, testId: "agent-list-create" } }
                : {})}
              className="border-0 bg-transparent"
            />
          ) : rows.length === 0 ? (
            <div className="px-2 py-6 text-center" data-testid="agent-list-no-matches">
              <p className="text-xs text-muted-foreground">{t("noMatches")}</p>
              {narrowed ? (
                <Button
                  variant="link"
                  size="sm"
                  className="mt-1 h-auto p-0 text-xs"
                  onClick={() => {
                    onQueryChange("")
                    onSourceChange("all")
                  }}
                >
                  {t("clearFilters")}
                </Button>
              ) : null}
            </div>
          ) : variant === "page" ? (
            <Surface asChild layer="raised" radius="panel">
              <ul
                className="divide-y divide-border/60 overflow-hidden border"
                data-testid="agent-list"
              >
                {list}
              </ul>
            </Surface>
          ) : (
            <ul className="space-y-0.5" data-testid="agent-list">
              {list}
            </ul>
          )}
        </nav>
      </ScrollArea>

      {selecting ? (
        <div
          className="flex shrink-0 items-center gap-1.5 border-t bg-background/80 px-2 py-2"
          data-testid="agent-list-bulk"
        >
          <span className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">
            {t("bulk.count", { count: chosen.length })}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={chosen.length === 0}
            onClick={() => actions.exportMany(chosen)}
            data-testid="agent-list-bulk-export"
          >
            <DownloadIcon className="size-3.5" aria-hidden />
            {t("bulk.export")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-destructive hover:text-destructive"
            disabled={chosen.length === 0}
            onClick={() => setConfirmDelete(true)}
            data-testid="agent-list-bulk-delete"
          >
            <Trash2Icon className="size-3.5" aria-hidden />
            {t("bulk.delete")}
          </Button>
        </div>
      ) : null}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("bulk.confirmTitle", { count: chosen.length })}</AlertDialogTitle>
            <AlertDialogDescription>{t("bulk.confirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("bulk.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void actions.removeMany(chosen).then(exitSelection)}
              data-testid="agent-list-bulk-confirm"
            >
              {t("bulk.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
