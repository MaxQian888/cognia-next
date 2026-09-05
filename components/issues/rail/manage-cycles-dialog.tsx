"use client"

/**
 * Create, edit and delete cycles and milestones for the active workspace.
 *
 * Reached from the rail's Cycles section, the way labels are reached from
 * the Labels section. Writes go straight to `lib/db/issue-cycles.ts`: a cycle
 * is a container, not an issue, so the bulk-action gate does not apply.
 * Planning an issue INTO a cycle is an `IssueBulkAction` elsewhere.
 */

import { PlusIcon, Trash2Icon } from "lucide-react"
import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/ui/native-select"
import { Progress } from "@/components/ui/progress"
import { createIssueCycle, deleteIssueCycle, updateIssueCycle } from "@/lib/db/issue-cycles"
import type { CycleProgress } from "@/lib/issues/relations"
import {
  ISSUE_CYCLE_KINDS,
  ISSUE_CYCLE_STATUSES,
  type IssueCycle,
  type IssueCycleKind,
  type IssueCycleStatus,
  type IssueProject,
} from "@/types/issues"

export interface ManageCyclesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Owning workspace id. */
  projectId: string
  cycles: readonly IssueCycle[]
  projects: readonly IssueProject[]
  progress: ReadonlyMap<string, CycleProgress>
}

function toDateInput(value: number | undefined): string {
  if (value === undefined) return ""
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`
}

function fromDateInput(value: string): number | null {
  if (!value) return null
  const [y, m, d] = value.split("-").map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d, 12).getTime()
}

export function ManageCyclesDialog({
  open,
  onOpenChange,
  projectId,
  cycles,
  projects,
  progress,
}: ManageCyclesDialogProps) {
  const t = useTranslations("issues.cycles")
  const [name, setName] = useState("")
  const [kind, setKind] = useState<IssueCycleKind>("cycle")
  const [busy, setBusy] = useState(false)
  /** Two clicks to delete: the second button only exists after the first. */
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

  async function create() {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      await createIssueCycle({ projectId, kind, name: trimmed })
      setName("")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function patch(_id: string, run: () => Promise<void>) {
    try {
      await run()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="manage-cycles-dialog">
        <DialogHeader>
          <DialogTitle>{t("manageTitle")}</DialogTitle>
        </DialogHeader>

        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Label htmlFor="cycle-name">{t("name")}</Label>
            <Input
              id="cycle-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("namePlaceholder")}
              data-testid="manage-cycles-name"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cycle-kind">{t("kind")}</Label>
            <NativeSelect
              id="cycle-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as IssueCycleKind)}
              data-testid="manage-cycles-kind"
            >
              {ISSUE_CYCLE_KINDS.map((option) => (
                <option key={option} value={option}>
                  {t(`kindLabel.${option}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button type="submit" disabled={busy || !name.trim()} data-testid="manage-cycles-create">
            <PlusIcon className="size-4" />
            {t("create")}
          </Button>
        </form>

        {cycles.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="manage-cycles-empty">
            {t("empty")}
          </p>
        ) : (
          <ul className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
            {cycles.map((cycle) => {
              const tally = progress.get(cycle.id) ?? {
                total: 0,
                done: 0,
                points: 0,
                pointsDone: 0,
              }
              const percent = tally.total === 0 ? 0 : Math.round((tally.done / tally.total) * 100)
              return (
                <li
                  key={cycle.id}
                  className="flex flex-col gap-2 rounded-md border p-3"
                  data-testid={`manage-cycles-row-${cycle.id}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      defaultValue={cycle.name}
                      aria-label={t("name")}
                      className="h-8 min-w-40 flex-1"
                      onBlur={(event) => {
                        const next = event.target.value.trim()
                        if (next && next !== cycle.name) {
                          void patch(cycle.id, () => updateIssueCycle(cycle.id, { name: next }))
                        }
                      }}
                      data-testid={`manage-cycles-name-${cycle.id}`}
                    />
                    <NativeSelect
                      value={cycle.status}
                      aria-label={t("status")}
                      className="h-8"
                      onChange={(event) =>
                        void patch(cycle.id, () =>
                          updateIssueCycle(cycle.id, {
                            status: event.target.value as IssueCycleStatus,
                          })
                        )
                      }
                      data-testid={`manage-cycles-status-${cycle.id}`}
                    >
                      {ISSUE_CYCLE_STATUSES.map((option) => (
                        <option key={option} value={option}>
                          {t(`statusLabel.${option}`)}
                        </option>
                      ))}
                    </NativeSelect>
                    <NativeSelect
                      value={cycle.issueProjectId ?? ""}
                      aria-label={t("scope")}
                      className="h-8"
                      onChange={(event) =>
                        void patch(cycle.id, () =>
                          updateIssueCycle(cycle.id, {
                            issueProjectId: event.target.value || null,
                          })
                        )
                      }
                      data-testid={`manage-cycles-scope-${cycle.id}`}
                    >
                      <option value="">{t("scopeWorkspace")}</option>
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </NativeSelect>
                    {pendingDeleteId === cycle.id ? (
                      <span className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            setPendingDeleteId(null)
                            void patch(cycle.id, () => deleteIssueCycle(cycle.id))
                          }}
                          data-testid={`manage-cycles-delete-confirm-${cycle.id}`}
                        >
                          {t("deleteConfirm", { count: tally.total })}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setPendingDeleteId(null)}
                          data-testid={`manage-cycles-delete-cancel-${cycle.id}`}
                        >
                          {t("cancel")}
                        </Button>
                      </span>
                    ) : (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        aria-label={t("delete", { name: cycle.name })}
                        onClick={() => setPendingDeleteId(cycle.id)}
                        data-testid={`manage-cycles-delete-${cycle.id}`}
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{t(`kindLabel.${cycle.kind}`)}</span>
                    <Input
                      type="date"
                      defaultValue={toDateInput(cycle.startsAt)}
                      aria-label={t("startsAt")}
                      className="h-7 w-36 text-xs"
                      onChange={(event) =>
                        void patch(cycle.id, () =>
                          updateIssueCycle(cycle.id, {
                            startsAt: fromDateInput(event.target.value),
                          })
                        )
                      }
                      data-testid={`manage-cycles-starts-${cycle.id}`}
                    />
                    <span aria-hidden>→</span>
                    <Input
                      type="date"
                      defaultValue={toDateInput(cycle.endsAt)}
                      aria-label={t("endsAt")}
                      className="h-7 w-36 text-xs"
                      onChange={(event) =>
                        void patch(cycle.id, () =>
                          updateIssueCycle(cycle.id, { endsAt: fromDateInput(event.target.value) })
                        )
                      }
                      data-testid={`manage-cycles-ends-${cycle.id}`}
                    />
                    <span className="flex-1" />
                    <span data-testid={`manage-cycles-progress-${cycle.id}`}>
                      {t("progress", {
                        done: tally.done,
                        total: tally.total,
                        pointsDone: tally.pointsDone,
                        points: tally.points,
                      })}
                    </span>
                  </div>
                  <Progress value={percent} className="h-1.5" aria-label={t("progressBar")} />
                </li>
              )
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
