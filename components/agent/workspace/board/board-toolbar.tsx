"use client"

// Board toolbar: swimlane toggle, tag/priority/assignee filters, the WIP
// hint, run controls (run/pause/resume driven by the live status), and the
// `agent.team.board.toolbar` plugin slot. Pure render shell over
// board-model's filter helpers.

import { useTranslations } from "next-intl"
import { FilterIcon, PauseIcon, PlayIcon, RowsIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Toggle } from "@/components/ui/toggle"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { cn } from "@/lib/utils"
import { agentTeamManager } from "@/lib/ai/agent/agent-team"
import { useTeamLiveStatus } from "@/hooks/agent-runs/use-team-live-status"
import {
  collectFilterOptions,
  isFilterActive,
  wipHint,
  EMPTY_BOARD_FILTER,
  type BoardFilter,
} from "@/lib/ai/agent/team/board-model"
import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"
import type { SubAgentPriority } from "@/types/agent/sub-agent"

const PRIORITY_OPTIONS: readonly SubAgentPriority[] = [
  "critical",
  "high",
  "normal",
  "low",
  "background",
]

export interface BoardToolbarProps {
  team: AgentTeam
  /** Unfiltered team tasks — filter options + WIP always reflect the whole board. */
  tasks: AgentTeamTask[]
  teammates: AgentTeammate[]
  filter: BoardFilter
  onFilterChange: (filter: BoardFilter) => void
  swimlanes: boolean
  onSwimlanesChange: (value: boolean) => void
}

function toggleValue<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

export function BoardToolbar({
  team,
  tasks,
  teammates,
  filter,
  onFilterChange,
  swimlanes,
  onSwimlanesChange,
}: BoardToolbarProps) {
  const t = useTranslations("agentTeamsWorkspace.tasks.board")
  const tPriority = useTranslations("agentPriority")
  const liveStatus = useTeamLiveStatus(team)
  const isLive = liveStatus === "executing" || liveStatus === "planning"

  const options = collectFilterOptions(tasks)
  const wip = wipHint(tasks, team.config.maxConcurrentTeammates)
  const nameOf = (id: string) => teammates.find((m) => m.id === id)?.name ?? id
  const activeFilterCount =
    filter.tags.length + filter.priorities.length + filter.assigneeIds.length

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="board-toolbar">
      <Toggle
        size="sm"
        pressed={swimlanes}
        onPressedChange={onSwimlanesChange}
        aria-label={t("swimlanes")}
        data-testid="board-swimlanes-toggle"
      >
        <RowsIcon className="mr-1 size-3.5" />
        {t("swimlanes")}
      </Toggle>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" data-testid="board-filter-trigger">
            <FilterIcon className="mr-1 size-3.5" />
            {t("filters")}
            {activeFilterCount > 0 && (
              <Badge variant="secondary" className="ml-1.5 px-1 py-0 text-[10px]">
                {activeFilterCount}
              </Badge>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 min-w-48 overflow-y-auto">
          <DropdownMenuLabel>{t("filterPriority")}</DropdownMenuLabel>
          {PRIORITY_OPTIONS.map((p) => (
            <DropdownMenuCheckboxItem
              key={p}
              checked={filter.priorities.includes(p)}
              onCheckedChange={() =>
                onFilterChange({ ...filter, priorities: toggleValue(filter.priorities, p) })
              }
              data-testid={`board-filter-priority-${p}`}
            >
              {tPriority(p)}
            </DropdownMenuCheckboxItem>
          ))}
          {options.tags.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("filterTags")}</DropdownMenuLabel>
              {options.tags.map((tag) => (
                <DropdownMenuCheckboxItem
                  key={tag}
                  checked={filter.tags.includes(tag)}
                  onCheckedChange={() =>
                    onFilterChange({ ...filter, tags: toggleValue(filter.tags, tag) })
                  }
                  data-testid={`board-filter-tag-${tag}`}
                >
                  {tag}
                </DropdownMenuCheckboxItem>
              ))}
            </>
          )}
          {options.assigneeIds.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("filterAssignee")}</DropdownMenuLabel>
              {options.assigneeIds.map((id) => (
                <DropdownMenuCheckboxItem
                  key={id}
                  checked={filter.assigneeIds.includes(id)}
                  onCheckedChange={() =>
                    onFilterChange({ ...filter, assigneeIds: toggleValue(filter.assigneeIds, id) })
                  }
                  data-testid={`board-filter-assignee-${id}`}
                >
                  {nameOf(id)}
                </DropdownMenuCheckboxItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {isFilterActive(filter) && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onFilterChange(EMPTY_BOARD_FILTER)}
          data-testid="board-filter-clear"
        >
          <XIcon className="mr-1 size-3.5" />
          {t("clearFilters")}
        </Button>
      )}

      <Badge
        variant={wip.over ? "destructive" : "outline"}
        className="text-[10px]"
        title={wip.over ? t("wipOver", { capacity: wip.capacity }) : undefined}
        data-testid="board-wip-hint"
      >
        {t("wip", { active: wip.active, capacity: wip.capacity })}
      </Badge>

      <div className="ml-auto flex items-center gap-1.5">
        {isLive ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void agentTeamManager.pause(team.id).catch(() => undefined)}
            data-testid="board-pause"
          >
            <PauseIcon className="mr-1 size-3.5" />
            {t("pause")}
          </Button>
        ) : liveStatus === "paused" ? (
          <Button
            size="sm"
            onClick={() => void agentTeamManager.resume(team.id).catch(() => undefined)}
            data-testid="board-resume"
          >
            <PlayIcon className="mr-1 size-3.5" />
            {t("resume")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void agentTeamManager.start(team.id).catch(() => undefined)}
            data-testid="board-run"
          >
            <PlayIcon className="mr-1 size-3.5" />
            {t("run")}
          </Button>
        )}
        <PluginExtensionSlot
          point="agent.team.board.toolbar"
          className={cn("flex items-center gap-1.5")}
          context={{ teamId: team.id, filter }}
        />
      </div>
    </div>
  )
}
