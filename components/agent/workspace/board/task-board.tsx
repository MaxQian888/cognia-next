"use client"

// Kanban board for the workspace tasks tab. Columns = the 8 task statuses
// (TASK_STATUS_CONFIG). Drag is guarded by canMoveTask: illegal drop targets
// grey out the moment a drag starts. Swimlane mode is a read view (drag off):
// dragging across lanes would imply reassignment, which the board deliberately
// does not do. Drag, columns, the overlay portal and keyboard movement come
// from the shared `components/board/kanban-board.tsx`.

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { BotIcon, ListTodoIcon } from "lucide-react"
import { toast } from "sonner"

import {
  KanbanBoard,
  type KanbanColumnModel,
  type KanbanDragState,
} from "@/components/board/kanban-board"
import { StatusBadge } from "@/components/status-badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useTeamLiveStatus } from "@/hooks/agent-runs/use-team-live-status"
import {
  EMPTY_BOARD_FILTER,
  applyBoardFilter,
  buildBoardColumns,
  buildSwimlanes,
  columnDropId,
  dependencyLockInfo,
  resolveDrop,
  type BoardFilter,
} from "@/lib/ai/agent/team/board-model"
import { allowedMoveTargets } from "@/lib/ai/agent/team/task-move-guard"
import { gatherTeamTwins } from "@/lib/ai/agent/team/twin-context"
import type { TeamTwinSummary } from "@/lib/ai/agent/team/team-run-context"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TASK_STATUS_CONFIG } from "@/types/agent/agent-team"
import type {
  AgentTeam,
  AgentTeammate,
  AgentTeamTask,
  TeamTaskStatus,
} from "@/types/agent/agent-team"
import { BoardToolbar } from "./board-toolbar"
import { OriginIssueChips } from "./origin-issue-chip"
import { TaskBoardCard } from "./task-card"

export interface TaskBoardProps {
  team: AgentTeam
  tasks: AgentTeamTask[]
  teammates: AgentTeammate[]
}

type TaskColumn = KanbanColumnModel<TeamTaskStatus, AgentTeamTask>
type TaskDrag = KanbanDragState<AgentTeamTask>

const taskId = (task: AgentTeamTask) => task.id
const taskLabel = (task: AgentTeamTask) => task.title
const columnClassName = () => "w-60 rounded-lg bg-muted/40"

export function TaskBoard({ team, tasks, teammates }: TaskBoardProps) {
  const t = useTranslations("agentTeamsWorkspace.tasks.board")
  const tStatus = useTranslations("agentTeam.taskStatus")
  const moveTask = useAgentTeamStore((s) => s.moveTask)
  const reorderTask = useAgentTeamStore((s) => s.reorderTask)
  const teamStatus = useTeamLiveStatus(team)

  const [filter, setFilter] = useState<BoardFilter>(EMPTY_BOARD_FILTER)
  const [swimlanes, setSwimlanes] = useState(false)

  // Twin visibility: resolve names/expertise for the bindings the runtime
  // already uses (teammate twinId + config.knowledgeTwinIds). Best-effort, an
  // empty list simply hides the badges.
  const [twins, setTwins] = useState<TeamTwinSummary[]>([])
  useEffect(() => {
    let cancelled = false
    void gatherTeamTwins().then((list) => {
      if (!cancelled) setTwins(list)
    })
    return () => {
      cancelled = true
    }
  }, [])
  const twinsById = useMemo(() => new Map(twins.map((t) => [t.id, t])), [twins])
  const twinOf = (teammateId: string | undefined) => {
    if (!teammateId) return undefined
    const twinId = teammates.find((m) => m.id === teammateId)?.config?.twinId
    return twinId
      ? (twinsById.get(twinId) ?? { id: twinId, name: twinId, expertise: "" })
      : undefined
  }
  const knowledgeTwinIds = team.config.knowledgeTwinIds ?? []

  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const filtered = useMemo(() => applyBoardFilter(tasks, filter), [tasks, filter])
  const columns = useMemo<TaskColumn[]>(
    () => buildBoardColumns(filtered).map((column) => ({ id: column.status, items: column.tasks })),
    [filtered]
  )
  const lanes = useMemo(
    () => (swimlanes ? buildSwimlanes(filtered, teammates) : []),
    [swimlanes, filtered, teammates]
  )

  const nameOf = (id: string | undefined) =>
    id ? teammates.find((m) => m.id === id)?.name : undefined

  const columnLabel = useCallback(
    (status: TeamTaskStatus) => tStatus(TASK_STATUS_CONFIG[status].labelKey),
    [tStatus]
  )

  // While a card is dragged, only its own column + guard-allowed targets stay
  // enabled. Everything else greys out (the visual "you can't drop here").
  const isDimmed = useCallback(
    (column: TaskColumn, drag: TaskDrag) => {
      const active = drag.activeItem
      if (!active || active.status === column.id) return false
      return !allowedMoveTargets(active, teamStatus).includes(column.id)
    },
    [teamStatus]
  )

  const handleDrop = (activeId: string, overId: string | null) => {
    const action = resolveDrop(activeId, overId, tasksById, teamStatus)
    if (!action) return
    if (action.type === "denied") {
      toast.error(t(`denied.${action.reason}`))
      return
    }
    if (action.type === "reorder") {
      reorderTask(action.taskId, action.targetIndex)
      return
    }
    const result = moveTask(action.taskId, action.to)
    if (!result.ok && result.reason) {
      toast.error(t(`denied.${result.reason}`))
    }
  }

  const renderColumnHeader = (column: TaskColumn) => (
    <StatusBadge
      value={TASK_STATUS_CONFIG[column.id].labelKey}
      labelNamespace="agentTeam.taskStatus"
      className="text-[10px]"
    />
  )

  const renderCard = (task: AgentTeamTask, dragDisabled: boolean) => (
    <TaskBoardCard
      task={task}
      assigneeName={nameOf(task.claimedBy ?? task.assignedTo)}
      twinName={twinOf(task.claimedBy ?? task.assignedTo)?.name}
      lock={dependencyLockInfo(task, tasksById)}
      dragDisabled={dragDisabled}
    />
  )

  /**
   * The clone is a PREVIEW rather than a second `TaskBoardCard`: that component
   * owns a dropdown, a comments dialog and a delete dialog, and rendering a
   * second copy would register a second sortable node under the same task id
   * for dnd-kit to measure against itself.
   */
  const renderOverlay = (task: AgentTeamTask) => {
    const assigneeName = nameOf(task.assignedTo)
    return (
      <div
        data-testid="task-drag-overlay"
        className="w-60 cursor-grabbing rounded-lg border bg-card p-2 shadow-lg ring-1 ring-border/60"
      >
        <p className="line-clamp-2 text-xs font-medium leading-snug">{task.title}</p>
        {assigneeName ? (
          <p className="mt-1 truncate text-[10px] text-muted-foreground">{assigneeName}</p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="space-y-3" data-testid="task-board">
      <BoardToolbar
        team={team}
        tasks={tasks}
        teammates={teammates}
        filter={filter}
        onFilterChange={setFilter}
        swimlanes={swimlanes}
        onSwimlanesChange={setSwimlanes}
      />

      {/* Where the work came from: the issues the run adapter dispatched here. */}
      <OriginIssueChips tasks={tasks} />

      {/* Knowledge twins the team can consult via twin_knowledge_search:
          team-level (config.knowledgeTwinIds), so shown once, not per card. */}
      {knowledgeTwinIds.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground"
          data-testid="board-knowledge-twins"
        >
          <span>{t("knowledgeTwins")}</span>
          {knowledgeTwinIds.map((id) => (
            <Badge key={id} variant="outline" className="gap-1 px-1.5 py-0 text-[10px]">
              <BotIcon className="size-3" />
              {twinsById.get(id)?.name ?? id}
            </Badge>
          ))}
        </div>
      )}

      {tasks.length === 0 ? (
        /* Team-level empty state. Without it a brand-new team shows a row of
           empty columns each repeating "no tasks", which reads as a broken
           board rather than an empty one and offers no way forward. */
        <Empty data-testid="board-empty">
          <EmptyMedia variant="icon">
            <ListTodoIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{t("empty.title")}</EmptyTitle>
            <EmptyDescription>{t("empty.description")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : swimlanes ? (
        <div className="space-y-4" data-testid="board-swimlanes">
          {lanes.map((lane) => (
            <div key={lane.teammateId ?? "__unassigned__"} className="space-y-1.5">
              <p
                className="flex items-center gap-2 text-xs font-medium"
                data-testid={`board-lane-${lane.teammateId ?? "unassigned"}`}
              >
                {lane.name ?? t("unassignedLane")}
                {lane.twinId && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="outline"
                        className="gap-1 px-1.5 py-0 text-[10px]"
                        data-testid={`board-lane-${lane.teammateId}-twin`}
                      >
                        <BotIcon className="size-3" />
                        {twinsById.get(lane.twinId)?.name ?? lane.twinId}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {t("twinBound", {
                        name: twinsById.get(lane.twinId)?.name ?? lane.twinId,
                      })}
                    </TooltipContent>
                  </Tooltip>
                )}
                <span className="text-[10px] font-normal text-muted-foreground">
                  {lane.taskCount}
                </span>
              </p>
              <KanbanBoard<TeamTaskStatus, AgentTeamTask>
                columns={lane.columns.map((column) => ({ id: column.status, items: column.tasks }))}
                itemId={taskId}
                itemLabel={taskLabel}
                columnLabel={columnLabel}
                dropId={columnDropId}
                renderColumnHeader={renderColumnHeader}
                columnClassName={columnClassName}
                renderCard={(task) => renderCard(task, true)}
                dragDisabled
                emptyText={t("emptyColumn")}
                testId={`board-lane-${lane.teammateId ?? "unassigned"}-columns`}
                testIdPrefix={`board-lane-${lane.teammateId ?? "unassigned"}`}
                className="gap-2 p-0 pb-1.5"
              />
            </div>
          ))}
          {lanes.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("emptyColumn")}</p>
          )}
        </div>
      ) : (
        <KanbanBoard<TeamTaskStatus, AgentTeamTask>
          columns={columns}
          itemId={taskId}
          itemLabel={taskLabel}
          columnLabel={columnLabel}
          dropId={columnDropId}
          renderColumnHeader={renderColumnHeader}
          columnClassName={columnClassName}
          renderCard={(task) => renderCard(task, false)}
          renderOverlay={renderOverlay}
          isDimmed={isDimmed}
          onDrop={handleDrop}
          emptyText={t("emptyColumn")}
          testId="board-columns"
          testIdPrefix="board"
          className="gap-2 p-0 pb-1.5"
        />
      )}
    </div>
  )
}
