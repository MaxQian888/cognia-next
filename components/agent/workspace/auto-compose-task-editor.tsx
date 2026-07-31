"use client"

/**
 * Editable task graph for the auto-compose preview.
 *
 * Field edits — title, description, assignee, dependencies — are applied
 * immutably via `onChange`. A task may only depend on EARLIER tasks (the
 * proposal's acyclic invariant), so the dependency toggles for task `i` only
 * offer tasks `0..i-1`. Add / remove are delegated to the dialog
 * (`onAdd` / `onRemove`) which routes them through the index-safe helpers in
 * `lib/ai/agent/team/auto/edit-proposal` so dependency indices stay consistent.
 */

import { useTranslations } from "next-intl"
import { PlusIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
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
import { cn } from "@/lib/utils"
import type { ProposedTask, ProposedTeammate } from "@/lib/ai/agent/team/auto/types"

export interface AutoComposeTaskEditorProps {
  tasks: ProposedTask[]
  roster: ProposedTeammate[]
  onChange: (tasks: ProposedTask[]) => void
  onAdd: () => void
  onRemove: (index: number) => void
}

export function AutoComposeTaskEditor({
  tasks,
  roster,
  onChange,
  onAdd,
  onRemove,
}: AutoComposeTaskEditorProps) {
  const t = useTranslations("agentTeamsWorkspace.autoCompose")

  const patchTask = (index: number, patch: Partial<ProposedTask>) =>
    onChange(tasks.map((task, i) => (i === index ? { ...task, ...patch } : task)))

  const toggleDependency = (index: number, dep: number) => {
    const current = new Set(tasks[index].dependencies)
    if (current.has(dep)) current.delete(dep)
    else current.add(dep)
    patchTask(index, { dependencies: [...current].sort((a, b) => a - b) })
  }

  return (
    <div className="space-y-2" data-testid="auto-compose-task-editor">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{t("tasksLabel", { count: tasks.length })}</Label>
        <Button size="sm" variant="outline" onClick={onAdd} data-testid="auto-compose-add-task">
          <PlusIcon className="mr-1 size-3" />
          {t("addTask")}
        </Button>
      </div>

      <ol className="space-y-2">
        {tasks.map((task, i) => (
          <li
            key={i}
            className="space-y-2 rounded-md border bg-muted/20 p-2.5"
            data-testid={`auto-compose-task-${i}`}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-muted-foreground">#{i}</span>
              <Input
                value={task.title}
                onChange={(e) => patchTask(i, { title: e.target.value })}
                placeholder={t("taskTitlePlaceholder")}
                className="h-7 flex-1 text-xs"
                aria-label={t("taskTitlePlaceholder")}
                data-testid={`auto-compose-task-title-${i}`}
              />
              <Button
                size="icon"
                variant="ghost"
                className="size-6 text-destructive"
                onClick={() => onRemove(i)}
                aria-label={t("removeTask")}
                title={t("removeTask")}
                data-testid={`auto-compose-remove-task-${i}`}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>

            <Textarea
              rows={2}
              value={task.description}
              onChange={(e) => patchTask(i, { description: e.target.value })}
              placeholder={t("taskDescriptionPlaceholder")}
              className="text-xs"
              aria-label={t("taskDescriptionPlaceholder")}
              data-testid={`auto-compose-task-desc-${i}`}
            />

            <div className="flex items-center gap-2">
              <Label className="text-[10px] text-muted-foreground">{t("assigneeLabel")}</Label>
              <Select
                value={String(task.assignedTo)}
                onValueChange={(v) => patchTask(i, { assignedTo: Number(v) })}
              >
                <SelectTrigger
                  size="sm"
                  className="h-7 flex-1 text-xs"
                  data-testid={`auto-compose-task-assignee-${i}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roster.map((m, idx) => (
                    <SelectItem key={idx} value={String(idx)}>
                      {m.name || `#${idx}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">{t("dependenciesLabel")}</Label>
              {i === 0 ? (
                <p className="text-[10px] text-muted-foreground/70">{t("noDependencies")}</p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {tasks.slice(0, i).map((dep, j) => {
                    const on = task.dependencies.includes(j)
                    return (
                      <button
                        key={j}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleDependency(i, j)}
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                          on
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:bg-muted"
                        )}
                        data-testid={`auto-compose-task-${i}-dep-${j}`}
                      >
                        #{j} {dep.title}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
