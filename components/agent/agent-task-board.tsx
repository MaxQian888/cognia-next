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
import { CalendarClockIcon, ListTodoIcon, MessageSquareIcon, PlayIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
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

  return (
    <Card
      ref={setNodeRef}
      className={cn("space-y-2 p-2.5", isDragging && "opacity-50")}
      style={
        transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
      }
      data-testid={`agent-task-${task.id}`}
    >
      <button
        type="button"
        className="w-full cursor-grab text-left active:cursor-grabbing"
        aria-label={task.title}
        {...listeners}
        {...attributes}
      >
        <p className="text-xs font-medium">{task.title}</p>
        {task.description && (
          <p className="line-clamp-2 text-[10px] text-muted-foreground">{task.description}</p>
        )}
      </button>
      <div className="flex flex-wrap gap-1">
        <Badge variant="secondary" className="text-[10px]">
          {t(`priority.${task.priority}`)}
        </Badge>
        {task.scheduledFor && (
          <Badge variant="outline" className="gap-1 text-[10px]">
            <CalendarClockIcon className="size-3" />
            {new Date(task.scheduledFor).toLocaleString()}
          </Badge>
        )}
        {task.dependencies.length > 0 && (
          <Badge variant="outline" className="text-[10px]">
            {t("dependencyCount", { count: task.dependencies.length })}
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {(["pending", "failed"] as AgentTaskStatus[]).includes(task.status) && (
          <Button
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => void run(() => runAgentTaskNow(task.id))}
          >
            <PlayIcon className="size-3" /> {task.status === "failed" ? t("retry") : t("start")}
          </Button>
        )}
        {task.status === "paused" && (
          <Button
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => void run(() => resumeAgentTask(task.id))}
          >
            {t("resume")}
          </Button>
        )}
        {task.status === "in_progress" && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            onClick={() => void run(() => pauseAgentTask(task.id))}
          >
            {t("pause")}
          </Button>
        )}
        {task.status === "review" && (
          <>
            <Button
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => void run(() => moveAgentTask(task.id, "completed"))}
            >
              {t("approve")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
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
            className="h-7 text-[11px]"
            onClick={() => void run(() => cancelAgentTask(task.id))}
          >
            {t("cancel")}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-[11px]"
          onClick={() => setExpanded((value) => !value)}
        >
          <MessageSquareIcon className="size-3" />
          {t("details", { attempts: attempts.length, comments: task.comments.length })}
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
        "w-64 shrink-0 space-y-2 rounded-lg bg-muted/40 p-2",
        isOver && "ring-2 ring-primary/40"
      )}
      data-testid={`agent-task-column-${status}`}
    >
      <div className="flex items-center justify-between px-1 text-xs font-medium">
        <span>{t(`status.${status}`)}</span>
        <span className="text-muted-foreground">{tasks.length}</span>
      </div>
      {tasks.map((task) => (
        <TaskCard key={task.id} task={task} />
      ))}
      {tasks.length === 0 && (
        <p className="rounded border border-dashed p-2 text-center text-[10px] text-muted-foreground">
          {t("emptyColumn")}
        </p>
      )}
    </section>
  )
}

export function AgentTaskBoard({ agentId }: { agentId: string }) {
  const t = useTranslations("agentTaskBoard")
  const tasks = useLiveQuery(() => listAgentTasks(agentId), [agentId]) ?? EMPTY_TASKS
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [priority, setPriority] = useState<AgentTaskPriority>("normal")
  const [approvalPolicy, setApprovalPolicy] = useState<AgentTask["approvalPolicy"]>("on-risk")
  const [scheduledFor, setScheduledFor] = useState("")
  const [dependencies, setDependencies] = useState<string[]>([])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const columns = useMemo(
    () =>
      STATUSES.map((status) => ({
        status,
        tasks: tasks.filter((task) => task.status === status),
      })),
    [tasks]
  )

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
    } catch (error) {
      toast.error(t("error", { message: error instanceof Error ? error.message : String(error) }))
    }
  }

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
    <div className="space-y-4" data-testid="agent-task-board">
      <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2">
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
          <Select
            value={priority}
            onValueChange={(value) => setPriority(value as AgentTaskPriority)}
          >
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
      {tasks.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <ListTodoIcon className="mx-auto mb-2 size-6 text-muted-foreground" />
          <p className="text-sm font-medium">{t("emptyTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("emptyDescription")}</p>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
          <div className="flex gap-2 overflow-x-auto pb-2">
            {columns.map((column) => (
              <TaskColumn key={column.status} {...column} />
            ))}
          </div>
        </DndContext>
      )}
    </div>
  )
}

export function AgentTaskBoardDialog({
  agentId,
  agentName,
}: {
  agentId: string
  agentName: string
}) {
  const t = useTranslations("agentTaskBoard")
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={t("openAria", { name: agentName })}
          title={t("open")}
        >
          <ListTodoIcon className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-[95vw] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle", { name: agentName })}</DialogTitle>
          <DialogDescription>{t("dialogDescription")}</DialogDescription>
        </DialogHeader>
        <AgentTaskBoard agentId={agentId} />
      </DialogContent>
    </Dialog>
  )
}
