"use client"

// Kanban board for the workspace tasks tab. Columns = the 8 task statuses
// (TASK_STATUS_CONFIG); drag is guarded by canMoveTask — illegal drop targets
// grey out the moment a drag starts (dnd-kit `useDroppable.disabled`).
// Swimlane mode is a read view (drag off): dragging across lanes would imply
// reassignment, which the board deliberately does not do.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  DndContext,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { toast } from "sonner"

import { StatusBadge } from "@/components/status-badge"
import { cn } from "@/lib/utils"
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
  type BoardColumn,
  type BoardFilter,
} from "@/lib/ai/agent/team/board-model"
import { allowedMoveTargets } from "@/lib/ai/agent/team/task-move-guard"
import { TASK_STATUS_CONFIG } from "@/types/agent/agent-team"
import type { AgentTeam, AgentTeammate, AgentTeamTask, TeamStatus } from "@/types/agent/agent-team"
import { BoardToolbar } from "./board-toolbar"
import { TaskBoardCard } from "./task-card"

export interface TaskBoardProps {
  team: AgentTeam
  tasks: AgentTeamTask[]
  teammates: AgentTeammate[]
}

function BoardColumnView({
  column,
  teamStatus,
  activeTask,
  nameOf,
  tasksById,
  dragDisabled,
}: {
  column: BoardColumn
  teamStatus: TeamStatus
  activeTask: AgentTeamTask | null
  nameOf: (id: string | undefined) => string | undefined
  tasksById: ReadonlyMap<string, AgentTeamTask>
  dragDisabled: boolean
}) {
  const t = useTranslations("agentTeamsWorkspace.tasks.board")
  // While a card is dragged, only its own column + guard-allowed targets stay
  // enabled; everything else greys out (the visual "you can't drop here").
  const dropDisabled =
    activeTask !== null &&
    activeTask.status !== column.status &&
    !allowedMoveTargets(activeTask, teamStatus).includes(column.status)
  const { setNodeRef, isOver } = useDroppable({
    id: columnDropId(column.status),
    disabled: dragDisabled || dropDisabled,
  })
  const cfg = TASK_STATUS_CONFIG[column.status]

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-60 shrink-0 flex-col gap-1.5 rounded-lg bg-muted/40 p-2 transition-opacity",
        dropDisabled && "opacity-40",
        isOver && !dropDisabled && "ring-2 ring-primary/40"
      )}
      data-testid={`board-column-${column.status}`}
      data-drop-disabled={dropDisabled || undefined}
    >
      <div className="flex items-center justify-between px-1">
        <StatusBadge
          value={cfg.labelKey}
          labelNamespace="agentTeam.taskStatus"
          className="text-[10px]"
        />
        <span
          className="text-[10px] text-muted-foreground"
          data-testid={`board-column-${column.status}-count`}
        >
          {column.tasks.length}
        </span>
      </div>
      <SortableContext
        items={column.tasks.map((task) => task.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex min-h-16 flex-col gap-1.5">
          {column.tasks.map((task) => (
            <TaskBoardCard
              key={task.id}
              task={task}
              assigneeName={nameOf(task.claimedBy ?? task.assignedTo)}
              lock={dependencyLockInfo(task, tasksById)}
              dragDisabled={dragDisabled}
            />
          ))}
          {column.tasks.length === 0 && (
            <p className="rounded border border-dashed border-border/60 p-2 text-center text-[10px] text-muted-foreground">
              {t("emptyColumn")}
            </p>
          )}
        </div>
      </SortableContext>
    </div>
  )
}

export function TaskBoard({ team, tasks, teammates }: TaskBoardProps) {
  const t = useTranslations("agentTeamsWorkspace.tasks.board")
  const moveTask = useAgentTeamStore((s) => s.moveTask)
  const reorderTask = useAgentTeamStore((s) => s.reorderTask)
  const teamStatus = useTeamLiveStatus(team)

  const [filter, setFilter] = useState<BoardFilter>(EMPTY_BOARD_FILTER)
  const [swimlanes, setSwimlanes] = useState(false)
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const filtered = useMemo(() => applyBoardFilter(tasks, filter), [tasks, filter])
  const columns = useMemo(() => buildBoardColumns(filtered), [filtered])
  const lanes = useMemo(
    () => (swimlanes ? buildSwimlanes(filtered, teammates) : []),
    [swimlanes, filtered, teammates]
  )

  const activeTask = activeTaskId ? (tasksById.get(activeTaskId) ?? null) : null
  const nameOf = (id: string | undefined) =>
    id ? teammates.find((m) => m.id === id)?.name : undefined

  const handleDragStart = (event: DragStartEvent) => {
    setActiveTaskId(String(event.active.id))
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTaskId(null)
    const action = resolveDrop(
      String(event.active.id),
      event.over ? String(event.over.id) : null,
      tasksById,
      teamStatus
    )
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

      {swimlanes ? (
        <div className="space-y-4" data-testid="board-swimlanes">
          {lanes.map((lane) => (
            <div key={lane.teammateId ?? "__unassigned__"} className="space-y-1.5">
              <p
                className="text-xs font-medium"
                data-testid={`board-lane-${lane.teammateId ?? "unassigned"}`}
              >
                {lane.name ?? t("unassignedLane")}
                <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                  {lane.taskCount}
                </span>
              </p>
              <div className="flex gap-2 overflow-x-auto pb-1.5">
                {lane.columns.map((column) => (
                  <BoardColumnView
                    key={column.status}
                    column={column}
                    teamStatus={teamStatus}
                    activeTask={null}
                    nameOf={nameOf}
                    tasksById={tasksById}
                    dragDisabled
                  />
                ))}
              </div>
            </div>
          ))}
          {lanes.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("emptyColumn")}</p>
          )}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveTaskId(null)}
        >
          <div className="flex gap-2 overflow-x-auto pb-1.5" data-testid="board-columns">
            {columns.map((column) => (
              <BoardColumnView
                key={column.status}
                column={column}
                teamStatus={teamStatus}
                activeTask={activeTask}
                nameOf={nameOf}
                tasksById={tasksById}
                dragDisabled={false}
              />
            ))}
          </div>
        </DndContext>
      )}
    </div>
  )
}
