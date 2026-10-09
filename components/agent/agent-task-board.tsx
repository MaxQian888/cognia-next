"use client"

import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import {
  DndContext,
  PointerSensor,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  CalendarClockIcon,
  HistoryIcon,
  LinkIcon,
  ListTodoIcon,
  MessageSquareIcon,
  PlayIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { SkillSuggestionCard } from "@/components/chat/skill-suggestion-card"
import { IssuePriorityIcon, IssueStatusIcon } from "@/components/issues/issue-glyphs"
import {
  addAgentTaskComment,
  createAgentTask,
  listAgentTaskAttempts,
  listAgentTasks,
  moveAgentTask,
} from "@/lib/db/agent-tasks"
import {
  cancelAgentTask,
  ensureAgentTaskSchedule,
  pauseAgentTask,
  resumeAgentTask,
  runAgentTaskNow,
} from "@/lib/agent-tasks/runtime"
import { allowedAgentTaskMoves } from "@/lib/agent-tasks/state-machine"
import {
  agentTaskPriorityToIssuePriority,
  agentTaskStatusToIssueStatus,
} from "@/lib/issues/sources/agent-status-map"
import { cn } from "@/lib/utils"
import type { AgentTask, AgentTaskPriority, AgentTaskStatus } from "@/types/agent/agent-task"

const STATUSES: readonly AgentTaskStatus[] = [
  "pending",
  "blocked",
  "in_progress",
  "review",
  "paused",
  "completed",
  "failed",
  "cancelled",
]
const EMPTY_TASKS: AgentTask[] = []

function TaskCard({ task }: { task: AgentTask }) {
  const t = useTranslations("agentTaskBoard")
  const [comment, setComment] = useState("")
  const [expanded, setExpanded] = useState(false)
  const attempts = useLiveQuery(() => listAgentTaskAttempts(task.id), [task.id]) ?? []
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id })
  const run = async (operation: () => Promise<unknown>) => {
    try {
      await operation()
    } catch (error) {
      toast.error(t("error", { message: error instanceof Error ? error.message : String(error) }))
    }
  }

  const actionClass = "h-6 px-2 text-[11px]"

  return (
    <Card
      ref={setNodeRef}
      className={cn("gap-2 p-2.5 shadow-none", isDragging && "opacity-50")}
      style={
        transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
      }
      data-testid={`agent-task-${task.id}`}
    >
      <button
        type="button"
        className="flex w-full cursor-grab items-start gap-1.5 text-left active:cursor-grabbing"
        aria-label={task.title}
        {...listeners}
        {...attributes}
      >
        <span className="mt-px shrink-0" title={t(`priority.${task.priority}`)}>
          <IssuePriorityIcon priority={agentTaskPriorityToIssuePriority(task.priority)} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[13px] font-medium leading-snug">{task.title}</span>
          {task.description && (
            <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
              {task.description}
            </span>
          )}
        </span>
      </button>
      {(task.scheduledFor || task.dependencies.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-5 text-[11px] text-muted-foreground">
          {task.scheduledFor && (
            <span className="inline-flex items-center gap-1">
              <CalendarClockIcon className="size-3" aria-hidden />
              {new Date(task.scheduledFor).toLocaleString()}
            </span>
          )}
          {task.dependencies.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <LinkIcon className="size-3" aria-hidden />
              {t("dependencyCount", { count: task.dependencies.length })}
            </span>
          )}
        </div>
      )}
      <div className="flex items-center gap-1">
        {(["pending", "failed"] as AgentTaskStatus[]).includes(task.status) && (
          <Button
            size="sm"
            className={actionClass}
            onClick={() => void run(() => runAgentTaskNow(task.id))}
          >
            <PlayIcon className="size-3" /> {task.status === "failed" ? t("retry") : t("start")}
          </Button>
        )}
        {task.status === "paused" && (
          <Button
            size="sm"
            className={actionClass}
            onClick={() => void run(() => resumeAgentTask(task.id))}
          >
            {t("resume")}
          </Button>
        )}
        {task.status === "in_progress" && (
          <Button
            size="sm"
            variant="outline"
            className={actionClass}
            onClick={() => void run(() => pauseAgentTask(task.id))}
          >
            {t("pause")}
          </Button>
        )}
        {task.status === "review" && (
          <>
            <Button
              size="sm"
              className={actionClass}
              onClick={() => void run(() => moveAgentTask(task.id, "completed"))}
            >
              {t("approve")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className={actionClass}
              onClick={() => void run(() => moveAgentTask(task.id, "failed"))}
            >
              {t("reject")}
            </Button>
          </>
        )}
        {allowedAgentTaskMoves(task.status).includes("cancelled") && (
          <Button
            size="sm"
            variant="ghost"
            className={cn(actionClass, "text-muted-foreground")}
            onClick={() => void run(() => cancelAgentTask(task.id))}
          >
            {t("cancel")}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 gap-1 px-1.5 text-[11px] text-muted-foreground tabular-nums"
          aria-label={t("details", { attempts: attempts.length, comments: task.comments.length })}
          aria-expanded={expanded}
          title={t("details", { attempts: attempts.length, comments: task.comments.length })}
          onClick={() => setExpanded((value) => !value)}
        >
          <HistoryIcon className="size-3" aria-hidden />
          {attempts.length}
          <MessageSquareIcon className="ml-1 size-3" aria-hidden />
          {task.comments.length}
        </Button>
      </div>
      {expanded && (
        <div className="space-y-2 border-t pt-2">
          {attempts.map((attempt) => (
            <div key={attempt.id} className="space-y-1">
              <p className="text-[10px] text-muted-foreground">
                {t("attempt", {
                  number: attempt.attemptNo,
                  status: t(`attemptStatus.${attempt.status}`),
                })}
              </p>
              <SkillSuggestionCard
                source={{
                  kind: "run",
                  runId: attempt.id,
                  ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
                }}
                outcome={{
                  completed: attempt.status === "completed" || attempt.status === "review",
                  turns: attempt.result?.trim() ? 2 : 0,
                  errorCount: 0,
                  denialCount: 0,
                  toolCallTotal: attempt.result?.trim() ? 2 : 0,
                  passedTests: 0,
                  failedTests: 0,
                  commitCount: 0,
                }}
              />
            </div>
          ))}
          {task.comments.map((entry) => (
            <p key={entry.id} className="rounded bg-muted px-2 py-1 text-[10px]">
              {entry.text}
            </p>
          ))}
          <div className="flex gap-1">
            <Input
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder={t("commentPlaceholder")}
              className="h-7 text-[11px]"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={!comment.trim()}
              onClick={() =>
                void run(async () => {
                  await addAgentTaskComment(task.id, {
                    id: crypto.randomUUID(),
                    author: "user",
                    text: comment,
                  })
                  setComment("")
                })
              }
            >
              {t("comment")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

function TaskColumn({ status, tasks }: { status: AgentTaskStatus; tasks: AgentTask[] }) {
  const t = useTranslations("agentTaskBoard")
  const { setNodeRef, isOver } = useDroppable({ id: `status:${status}` })
  return (
    <section
      ref={setNodeRef}
      className={cn(
        // Grow to share the width, never below a readable card; the whole
        // column is the drop target, its list scrolls on its own.
        "flex min-h-0 flex-[1_0_15rem] flex-col rounded-lg bg-muted/40",
        isOver && "ring-2 ring-primary/40"
      )}
      data-testid={`agent-task-column-${status}`}
    >
      <header className="flex shrink-0 items-center gap-1.5 px-3 pb-1.5 pt-2.5 text-xs font-medium">
        <IssueStatusIcon status={agentTaskStatusToIssueStatus(status)} className="size-3.5" />
        <span>{t(`status.${status}`)}</span>
        <span className="ml-auto text-muted-foreground tabular-nums">{tasks.length}</span>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} />
        ))}
        {tasks.length === 0 && (
          <p className="rounded-md border border-dashed py-3 text-center text-[11px] text-muted-foreground">
            {t("emptyColumn")}
          </p>
        )}
      </div>
    </section>
  )
}

/**
 * The durable-task form for one agent: title, priority, description, approval
 * policy, schedule and dependencies. Shared by the board below and by the
 * agents console's "Assign work" dialog (ADR-0220), so both create a task the
 * same way, scheduling included.
 */
export function AgentTaskCreateForm({
  agentId,
  onCreated,
  className,
}: {
  agentId: string
  onCreated?: (task: AgentTask) => void
  className?: string
}) {
  const t = useTranslations("agentTaskBoard")
  const tasks = useLiveQuery(() => listAgentTasks(agentId), [agentId]) ?? EMPTY_TASKS
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [priority, setPriority] = useState<AgentTaskPriority>("normal")
  const [approvalPolicy, setApprovalPolicy] = useState<AgentTask["approvalPolicy"]>("on-risk")
  const [scheduledFor, setScheduledFor] = useState("")
  const [dependencies, setDependencies] = useState<string[]>([])

  const create = async () => {
    try {
      const task = await createAgentTask({
        agentId,
        title,
        description,
        priority,
        approvalPolicy,
        dependencies,
        scheduledFor: scheduledFor ? new Date(scheduledFor).getTime() : undefined,
      })
      if (task.scheduledFor) await ensureAgentTaskSchedule(task.id)
      setTitle("")
      setDescription("")
      setScheduledFor("")
      setDependencies([])
      onCreated?.(task)
    } catch (error) {
      toast.error(t("error", { message: error instanceof Error ? error.message : String(error) }))
    }
  }

  return (
    <div
      className={cn("grid gap-2 rounded-lg border p-3 sm:grid-cols-2", className)}
      data-testid="agent-task-create-form"
    >
      <div className="space-y-1">
        <Label htmlFor={`agent-task-title-${agentId}`}>{t("titleLabel")}</Label>
        <Input
          id={`agent-task-title-${agentId}`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label>{t("priorityLabel")}</Label>
        <Select value={priority} onValueChange={(value) => setPriority(value as AgentTaskPriority)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["low", "normal", "high", "critical"] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {t(`priority.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor={`agent-task-description-${agentId}`}>{t("descriptionLabel")}</Label>
        <Textarea
          id={`agent-task-description-${agentId}`}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label>{t("approvalLabel")}</Label>
        <Select
          value={approvalPolicy}
          onValueChange={(value) => setApprovalPolicy(value as AgentTask["approvalPolicy"])}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["auto", "on-risk", "manual"] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {t(`approval.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`agent-task-schedule-${agentId}`}>{t("scheduleLabel")}</Label>
        <Input
          id={`agent-task-schedule-${agentId}`}
          type="datetime-local"
          value={scheduledFor}
          onChange={(event) => setScheduledFor(event.target.value)}
        />
      </div>
      {tasks.length > 0 && (
        <div className="space-y-1 sm:col-span-2">
          <Label>{t("dependenciesLabel")}</Label>
          <div className="flex flex-wrap gap-2">
            {tasks.map((task) => (
              <label key={task.id} className="flex items-center gap-1 text-xs">
                <Checkbox
                  checked={dependencies.includes(task.id)}
                  onCheckedChange={(checked) =>
                    setDependencies((current) =>
                      checked ? [...current, task.id] : current.filter((id) => id !== task.id)
                    )
                  }
                />
                {task.title}
              </label>
            ))}
          </div>
        </div>
      )}
      <Button disabled={!title.trim()} onClick={() => void create()} className="sm:col-span-2">
        {t("create")}
      </Button>
    </div>
  )
}

export function AgentTaskBoard({
  agentId,
  showCreateForm = true,
  emptyState,
  className,
}: {
  agentId: string
  /**
   * Give the board a bounded height (e.g. `min-h-0 flex-1` in a flex column)
   * and the columns fill it, each scrolling its own cards.
   */
  className?: string
  /** The agents console opens the form from its header instead (ADR-0220). */
  showCreateForm?: boolean
  /**
   * Shown instead of the board's own empty panel. The default panel points at
   * the inline form above it, which a host without the form must not say.
   */
  emptyState?: React.ReactNode
}) {
  const t = useTranslations("agentTaskBoard")
  const tasks = useLiveQuery(() => listAgentTasks(agentId), [agentId]) ?? EMPTY_TASKS
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const columns = useMemo(
    () =>
      STATUSES.map((status) => ({
        status,
        tasks: tasks.filter((task) => task.status === status),
      })),
    [tasks]
  )

  const onDragEnd = (event: DragEndEvent) => {
    const task = tasks.find((candidate) => candidate.id === String(event.active.id))
    const over = event.over ? String(event.over.id) : ""
    if (!task || !over.startsWith("status:")) return
    const target = over.slice("status:".length) as AgentTaskStatus
    if (!allowedAgentTaskMoves(task.status).includes(target)) {
      toast.error(t("moveDenied"))
      return
    }
    void moveAgentTask(task.id, target).catch((error) =>
      toast.error(t("error", { message: error instanceof Error ? error.message : String(error) }))
    )
  }

  return (
    <div className={cn("flex min-h-0 flex-col gap-4", className)} data-testid="agent-task-board">
      {showCreateForm ? <AgentTaskCreateForm agentId={agentId} /> : null}
      {tasks.length === 0 && emptyState !== undefined ? (
        emptyState
      ) : tasks.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <ListTodoIcon className="mx-auto mb-2 size-6 text-muted-foreground" />
          <p className="text-sm font-medium">{t("emptyTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("emptyDescription")}</p>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-1">
            {columns.map((column) => (
              <TaskColumn key={column.status} {...column} />
            ))}
          </div>
        </DndContext>
      )}
    </div>
  )
}
