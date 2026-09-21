"use client"

/**
 * Create, edit and delete the cycles and milestones of one workspace.
 *
 * One editor, two mounts: the dialog the issue rail opens and the Cycles tab of
 * the tracker (`cycle-console.tsx`). Writes go straight to
 * `lib/db/issue-cycles.ts`: a cycle is a container, not an issue, so the
 * bulk-action gate does not apply. Planning an issue INTO a cycle is an
 * `IssueBulkAction` elsewhere.
 */

import {
  CalendarIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  FlagIcon,
  ListFilterIcon,
  PlusIcon,
  RotateCwIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { createIssueCycle, deleteIssueCycle, updateIssueCycle } from "@/lib/db/issue-cycles"
import type { CycleProgress } from "@/lib/issues/relations"
import { cn } from "@/lib/utils"
import {
  ISSUE_CYCLE_KINDS,
  ISSUE_CYCLE_STATUSES,
  type IssueCycle,
  type IssueCycleKind,
  type IssueCycleStatus,
  type IssueProject,
} from "@/types/issues"

export interface CycleEditorListProps {
  /** Owning workspace id. */
  projectId: string
  cycles: readonly IssueCycle[]
  projects: readonly IssueProject[]
  progress: ReadonlyMap<string, CycleProgress>
  /**
   * Show a "view issues" link per row (`/issues?cycle=`). The rail dialog
   * leaves it off because the board is already behind the dialog.
   */
  linkToBoard?: boolean
  /** Bound the list's height (the dialog) or let the page scroll (the tab). */
  listClassName?: string
}

/** Icons per cycle kind — RotateCw matches the tracker tab's cycle glyph. */
const KIND_ICON: Record<IssueCycleKind, LucideIcon> = {
  cycle: RotateCwIcon,
  milestone: FlagIcon,
}

/** Status glyphs reuse the board's circle vocabulary and token colours. */
const STATUS_ICON: Record<IssueCycleStatus, LucideIcon> = {
  planned: CircleDashedIcon,
  active: CircleDotIcon,
  completed: CircleCheckIcon,
}

const STATUS_COLOR: Record<IssueCycleStatus, string> = {
  planned: "text-muted-foreground",
  active: "text-amber-500",
  completed: "text-blue-500",
}

function formatCycleDate(value: number | null | undefined): string | null {
  if (value == null) return null
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

interface CycleDateButtonProps {
  label: string
  value: number | null | undefined
  onPick: (value: number | null) => void
  testId: string
  clearLabel: string
}

/** Compact date pill: calendar popover + clear, used by both the form and rows. */
function CycleDateButton({ label, value, onPick, testId, clearLabel }: CycleDateButtonProps) {
  const formatted = formatCycleDate(value)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid={testId}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-input px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <CalendarIcon className="size-3.5" />
          {formatted ? <span className="text-foreground tabular-nums">{formatted}</span> : label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={value != null ? new Date(value) : undefined}
          onSelect={(date) => onPick(date ? new Date(date).setHours(12, 0, 0, 0) : null)}
        />
        <div className="flex justify-end border-t p-1.5">
          <button
            type="button"
            onClick={() => onPick(null)}
            data-testid={`${testId}-clear`}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {clearLabel}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function CycleEditorList({
  projectId,
  cycles,
  projects,
  progress,
  linkToBoard = false,
  listClassName,
}: CycleEditorListProps) {
  const t = useTranslations("issues.cycles")
  const [name, setName] = useState("")
  const [kind, setKind] = useState<IssueCycleKind>("cycle")
  const [startsAt, setStartsAt] = useState<number | undefined>(undefined)
  const [endsAt, setEndsAt] = useState<number | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  /** Two clicks to delete: the second button only exists after the first. */
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

  async function create() {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      await createIssueCycle({
        projectId,
        kind,
        name: trimmed,
        ...(startsAt !== undefined ? { startsAt } : {}),
        ...(endsAt !== undefined ? { endsAt } : {}),
      })
      setName("")
      setStartsAt(undefined)
      setEndsAt(undefined)
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
    <div className="flex flex-col gap-4" data-testid="cycle-editor-list">
      <form
        className="flex flex-col gap-3 rounded-md border bg-card p-3"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Label htmlFor="cycle-name" className="sr-only">
              {t("name")}
            </Label>
            <Input
              id="cycle-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("namePlaceholder")}
              className="h-8"
              data-testid="manage-cycles-name"
            />
          </div>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={kind}
            onValueChange={(value) => {
              if (value) setKind(value as IssueCycleKind)
            }}
            aria-label={t("kind")}
            data-testid="manage-cycles-kind"
          >
            {ISSUE_CYCLE_KINDS.map((option) => {
              const Icon = KIND_ICON[option]
              return (
                <ToggleGroupItem
                  key={option}
                  value={option}
                  aria-label={t(`kindLabel.${option}`)}
                  data-testid={`manage-cycles-kind-${option}`}
                  className="gap-1.5 px-2.5 text-xs"
                >
                  <Icon className="size-3.5" />
                  {t(`kindLabel.${option}`)}
                </ToggleGroupItem>
              )
            })}
          </ToggleGroup>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CycleDateButton
            label={t("startsAt")}
            value={startsAt}
            onPick={(value) => setStartsAt(value ?? undefined)}
            testId="manage-cycles-starts-new"
            clearLabel={t("clear")}
          />
          <span aria-hidden className="text-xs text-muted-foreground">
            →
          </span>
          <CycleDateButton
            label={t("endsAt")}
            value={endsAt}
            onPick={(value) => setEndsAt(value ?? undefined)}
            testId="manage-cycles-ends-new"
            clearLabel={t("clear")}
          />
          <span className="flex-1" />
          <Button
            type="submit"
            size="sm"
            disabled={busy || !name.trim()}
            data-testid="manage-cycles-create"
          >
            <PlusIcon className="size-4" />
            {t("create")}
          </Button>
        </div>
      </form>

      {cycles.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="manage-cycles-empty">
          {t("empty")}
        </p>
      ) : (
        <ul className={cn("flex flex-col gap-2", listClassName)}>
          {cycles.map((cycle) => {
            const tally = progress.get(cycle.id) ?? {
              total: 0,
              done: 0,
              points: 0,
              pointsDone: 0,
            }
            const percent = tally.total === 0 ? 0 : Math.round((tally.done / tally.total) * 100)
            const KindIcon = KIND_ICON[cycle.kind]
            return (
              <li
                key={cycle.id}
                className="flex flex-col gap-2.5 rounded-md border p-3"
                data-testid={`manage-cycles-row-${cycle.id}`}
              >
                <div className="flex items-center gap-2">
                  <KindIcon
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground"
                    data-testid={`manage-cycles-kindicon-${cycle.id}`}
                  />
                  <Input
                    defaultValue={cycle.name}
                    aria-label={t("name")}
                    className="h-8 min-w-0 flex-1 font-medium"
                    onBlur={(event) => {
                      const next = event.target.value.trim()
                      if (next && next !== cycle.name) {
                        void patch(cycle.id, () => updateIssueCycle(cycle.id, { name: next }))
                      }
                    }}
                    data-testid={`manage-cycles-name-${cycle.id}`}
                  />
                  <Select
                    value={cycle.status}
                    onValueChange={(value) =>
                      void patch(cycle.id, () =>
                        updateIssueCycle(cycle.id, { status: value as IssueCycleStatus })
                      )
                    }
                  >
                    <SelectTrigger
                      aria-label={t("status")}
                      className="h-8 gap-1.5 text-xs"
                      data-testid={`manage-cycles-status-${cycle.id}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ISSUE_CYCLE_STATUSES.map((option) => {
                        const Icon = STATUS_ICON[option]
                        return (
                          <SelectItem key={option} value={option} className="text-xs">
                            <Icon aria-hidden className={cn("size-3.5", STATUS_COLOR[option])} />
                            {t(`statusLabel.${option}`)}
                          </SelectItem>
                        )
                      })}
                    </SelectContent>
                  </Select>
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
                      className="shrink-0 text-destructive hover:text-destructive"
                      aria-label={t("delete", { name: cycle.name })}
                      onClick={() => setPendingDeleteId(cycle.id)}
                      data-testid={`manage-cycles-delete-${cycle.id}`}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <CycleDateButton
                    label={t("startsAt")}
                    value={cycle.startsAt}
                    onPick={(value) =>
                      void patch(cycle.id, () => updateIssueCycle(cycle.id, { startsAt: value }))
                    }
                    testId={`manage-cycles-starts-${cycle.id}`}
                    clearLabel={t("clear")}
                  />
                  <span aria-hidden>→</span>
                  <CycleDateButton
                    label={t("endsAt")}
                    value={cycle.endsAt}
                    onPick={(value) =>
                      void patch(cycle.id, () => updateIssueCycle(cycle.id, { endsAt: value }))
                    }
                    testId={`manage-cycles-ends-${cycle.id}`}
                    clearLabel={t("clear")}
                  />
                  <Select
                    value={cycle.issueProjectId ?? "workspace"}
                    onValueChange={(value) =>
                      void patch(cycle.id, () =>
                        updateIssueCycle(cycle.id, {
                          issueProjectId: value === "workspace" ? null : value,
                        })
                      )
                    }
                  >
                    <SelectTrigger
                      aria-label={t("scope")}
                      className="h-7 gap-1.5 border-0 px-1.5 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-foreground"
                      data-testid={`manage-cycles-scope-${cycle.id}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="workspace" className="text-xs">
                        {t("scopeWorkspace")}
                      </SelectItem>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id} className="text-xs">
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {linkToBoard ? (
                    <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
                      <Link
                        href={`/issues?cycle=${encodeURIComponent(cycle.id)}`}
                        data-testid={`manage-cycles-view-${cycle.id}`}
                      >
                        <ListFilterIcon className="size-3.5" />
                        {t("viewIssues")}
                      </Link>
                    </Button>
                  ) : null}
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
    </div>
  )
}
