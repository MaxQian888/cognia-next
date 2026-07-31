"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion } from "motion/react"
import {
  MOBILE_SPRING,
  STAGGER_CHILD,
  STAGGER_CONTAINER,
  useReducedMotionTransition,
  useReducedMotionVariants,
} from "@/lib/ui/motion"
import {
  KanbanIcon,
  ListIcon,
  ListTodoIcon,
  MessageSquareIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"

import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/components/status-badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { TASK_STATUS_CONFIG } from "@/types/agent/agent-team"
import type { AgentTeamTask, AgentTeammate } from "@/types/agent/agent-team"
import { createLogger } from "@cognia/logging"
import { TaskComments } from "./task-comments"
import { TaskBoard } from "./board/task-board"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { gatherTeamTwins } from "@/lib/ai/agent/team/twin-context"
import { rankAssigneesForTask } from "@/lib/ai/agent/team/twin-expertise-hints"
import type { TeamTwinSummary } from "@/lib/ai/agent/team/team-run-context"

const log = createLogger("agentTeams.tasks")

/** Left-border accent color keyed to task priority. */
function priorityAccent(priority?: string): string {
  switch (priority) {
    case "critical":
      return "border-l-red-500"
    case "high":
      return "border-l-amber-500"
    case "low":
      return "border-l-blue-500"
    case "background":
      return "border-l-slate-400"
    default:
      return "border-l-border"
  }
}

const PRIORITIES: ReadonlyArray<{ value: string; labelKey: string }> = [
  { value: "critical", labelKey: "critical" },
  { value: "high", labelKey: "high" },
  { value: "normal", labelKey: "normal" },
  { value: "low", labelKey: "low" },
  { value: "background", labelKey: "background" },
]

export interface AgentTeamTasksProps {
  teamId: string
  tasks: AgentTeamTask[]
  teammates: AgentTeammate[]
}

export function AgentTeamTasks({ teamId, tasks, teammates }: AgentTeamTasksProps) {
  const t = useTranslations("agentTeamsWorkspace.tasks")
  const tPriority = useTranslations("agentPriority")
  const createTask = useAgentTeamStore((s) => s.createTask)
  const deleteTask = useAgentTeamStore((s) => s.deleteTask)
  const tasksView = useAgentTeamStore((s) => s.tasksView)
  const setTasksView = useAgentTeamStore((s) => s.setTasksView)
  const team = useAgentTeamStore((s) => s.teams[teamId])

  const [showForm, setShowForm] = useState(false)
  const [title, setTitle] = useState("")

  // Twin-expertise assignee hints: resolve the roster's twin bindings once the
  // form opens (best-effort; empty list = plain alphabetical roster).
  const [twins, setTwins] = useState<TeamTwinSummary[]>([])
  useEffect(() => {
    if (!showForm) return
    let cancelled = false
    void gatherTeamTwins().then((list) => {
      if (!cancelled) setTwins(list)
    })
    return () => {
      cancelled = true
    }
  }, [showForm])
  const [description, setDescription] = useState("")
  const [priority, setPriority] = useState("normal")
  const [assigneeId, setAssigneeId] = useState("")
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)

  const handleCreate = () => {
    if (!title.trim()) return
    createTask({
      teamId,
      title: title.trim(),
      description: description.trim() || title.trim(),
      priority: priority as AgentTeamTask["priority"],
      assignedTo: assigneeId || undefined,
    })
    log.info("task_created", { teamId, title: title.trim() })
    toast.success(t("taskCreated"))
    setTitle("")
    setDescription("")
    setPriority("normal")
    setAssigneeId("")
    setShowForm(false)
  }

  if (tasks.length === 0 && !showForm) {
    return (
      <Empty className="mx-auto w-full max-w-lg">
        <EmptyMedia variant="icon">
          <ListTodoIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>{t("empty")}</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={() => setShowForm(true)}>
            <PlusIcon className="mr-2 size-4" />
            {t("createTask")}
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  return (
    <div className="space-y-4" data-testid="workspace-tasks">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t("tasksCount", { count: tasks.length })}</p>
        <div className="flex items-center gap-2">
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={tasksView}
            onValueChange={(v) => {
              if (v === "list" || v === "board") setTasksView(v)
            }}
            aria-label={t("board.viewToggle")}
          >
            <ToggleGroupItem
              value="list"
              aria-label={t("board.viewList")}
              data-testid="tasks-view-list"
            >
              <ListIcon className="size-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem
              value="board"
              aria-label={t("board.viewBoard")}
              data-testid="tasks-view-board"
            >
              <KanbanIcon className="size-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
          {!showForm && (
            <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
              <PlusIcon className="mr-2 size-3.5" />
              {t("createTask")}
            </Button>
          )}
        </div>
      </div>

      {/* Create form */}
      {showForm && (
        <Card className="space-y-3 p-4" data-testid="task-create-form">
          <div className="space-y-1">
            <Label className="text-xs">{t("title")}</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("taskTitlePlaceholder")}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("description")}</Label>
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("taskDescriptionPlaceholder")}
              className="text-xs"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">{t("priority")}</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {tPriority(p.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("assignee")}</Label>
              <Select value={assigneeId} onValueChange={setAssigneeId}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder={t("unassigned")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{t("unassigned")}</SelectItem>
                  {/* Ranked by twin-expertise overlap with the typed title —
                      pure token matching over data the runtime already has
                      (see twin-expertise-hints.ts). */}
                  {rankAssigneesForTask({ title, tags: [] }, teammates, twins).map((hint) => (
                    <SelectItem key={hint.teammateId} value={hint.teammateId}>
                      {hint.teammateName}
                      {hint.twinName ? ` · ${hint.twinName}` : ""}
                      {hint.score > 0 && hint.expertise ? ` — ${hint.expertise.slice(0, 60)}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>
              {t("cancel")}
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={!title.trim()}>
              {t("save")}
            </Button>
          </div>
        </Card>
      )}

      {/* Board view (kanban) — list stays the default */}
      {tasksView === "board" && team ? (
        <TaskBoard team={team} tasks={tasks} teammates={teammates} />
      ) : (
        <TaskListGrid
          tasks={tasks}
          teammates={teammates}
          expandedTaskId={expandedTaskId}
          setExpandedTaskId={setExpandedTaskId}
          deleteTask={deleteTask}
        />
      )}
    </div>
  )
}

/** The original flat card grid, extracted so the view toggle stays readable. */
function TaskListGrid({
  tasks,
  teammates,
  expandedTaskId,
  setExpandedTaskId,
  deleteTask,
}: {
  tasks: AgentTeamTask[]
  teammates: AgentTeammate[]
  expandedTaskId: string | null
  setExpandedTaskId: (updater: (prev: string | null) => string | null) => void
  deleteTask: (taskId: string) => void
}) {
  const t = useTranslations("agentTeamsWorkspace.tasks")
  const tPriority = useTranslations("agentPriority")
  // `layout` + spring so deleting a card makes the survivors flow into the gap
  // rather than teleport; the exit variant means the deleted card leaves rather
  // than blinking out. Both come from the shared tokens, so the reduced-motion
  // preference collapses them without a second code path here.
  const childVariants = useReducedMotionVariants(STAGGER_CHILD)
  const layoutTransition = useReducedMotionTransition(MOBILE_SPRING)
  return (
    <motion.div
      className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3 items-start"
      variants={STAGGER_CONTAINER}
      initial="initial"
      animate="animate"
    >
      <AnimatePresence initial={false}>
        {tasks.map((task) => {
          const cfg = TASK_STATUS_CONFIG[task.status]
          const assignee = task.assignedTo ? teammates.find((m) => m.id === task.assignedTo) : null
          return (
            <motion.div
              key={task.id}
              layout
              variants={childVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={layoutTransition}
            >
              <Card
                className={cn("space-y-1 border-l-2 p-3", priorityAccent(task.priority))}
                data-testid={`task-${task.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium truncate">{task.title}</p>
                      <StatusBadge
                        value={cfg?.labelKey ?? task.status}
                        labelNamespace="agentTeam.taskStatus"
                        pulse={task.status === "in_progress" || task.status === "claimed"}
                        className="text-[10px] shrink-0"
                        data-testid={`task-${task.id}-status`}
                      />
                      {task.priority && (
                        <Badge variant="secondary" className="text-[10px] shrink-0">
                          {tPriority(task.priority)}
                        </Badge>
                      )}
                    </div>
                    {task.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {task.description}
                      </p>
                    )}
                    <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
                      {assignee && <span>{assignee.name}</span>}
                      {task.tags && task.tags.length > 0 && (
                        <span className="flex gap-1">
                          {task.tags.map((tag) => (
                            <span key={tag} className="rounded bg-muted px-1 py-0.5">
                              {tag}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2Icon className="size-3" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
                        <AlertDialogDescription>{t("deleteBody")}</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          onClick={() => {
                            deleteTask(task.id)
                            toast.success(t("taskDeleted"))
                          }}
                        >
                          {t("delete")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
                {task.error && <p className="text-xs text-destructive">{task.error}</p>}
                {task.result && (
                  <p className="line-clamp-2 text-[11px] italic text-muted-foreground">
                    {task.result}
                  </p>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => setExpandedTaskId((prev) => (prev === task.id ? null : task.id))}
                  aria-expanded={expandedTaskId === task.id}
                  data-testid={`task-${task.id}-comments-toggle`}
                >
                  <MessageSquareIcon className="mr-1 size-3" />
                  {t("comments.count", { count: task.comments?.length ?? 0 })}
                </Button>
                {expandedTaskId === task.id && <TaskComments taskId={task.id} />}
              </Card>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </motion.div>
  )
}
