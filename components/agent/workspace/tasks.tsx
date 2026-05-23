"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { ListTodoIcon, PlusIcon, Trash2Icon } from "lucide-react"

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

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { TASK_STATUS_CONFIG } from "@/types/agent/agent-team"
import type { AgentTeamTask, AgentTeammate } from "@/types/agent/agent-team"
import { createLogger } from "@/lib/logging"

const log = createLogger("agentTeams.tasks")

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
  const prefersReducedMotion = useReducedMotion()
  const createTask = useAgentTeamStore((s) => s.createTask)
  const deleteTask = useAgentTeamStore((s) => s.deleteTask)

  const [showForm, setShowForm] = useState(false)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [priority, setPriority] = useState("normal")
  const [assigneeId, setAssigneeId] = useState("")

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
      <Empty>
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
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{t("tasksCount", { count: tasks.length })}</p>
        {!showForm && (
          <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
            <PlusIcon className="mr-2 size-3.5" />
            {t("createTask")}
          </Button>
        )}
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
                  {teammates.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
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

      {/* Task list */}
      <div className="space-y-2">
        {tasks.map((task, index) => {
          const cfg = TASK_STATUS_CONFIG[task.status]
          const assignee = task.assignedTo ? teammates.find((m) => m.id === task.assignedTo) : null
          return (
            <motion.div
              key={task.id}
              initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.15,
                ease: "easeOut",
                delay: prefersReducedMotion ? 0 : Math.min(index * 0.03, 0.15),
              }}
            >
              <Card className="space-y-1 p-3" data-testid={`task-${task.id}`}>
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
              </Card>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}
