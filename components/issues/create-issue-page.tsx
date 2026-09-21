"use client"

/**
 * "New issue" — the create surface, modelled on GitHub's New Issue page:
 * a right-hand sheet with a two-column layout (document editor left,
 * metadata sidebar right).
 *
 *   left  — borderless title, a bordered markdown editor (Write/Preview tabs,
 *           formatting toolbar, templates, ✨ AI assist, `#` issue-reference
 *           completion, autosaved draft), and the relationships row
 *           (parent + blocked-by pickers)
 *   right — live board-card preview plus status / priority / assignee /
 *           labels / project / cycle / due / estimate controls; on the
 *           shared-org destination the local-only fields hide because the
 *           collab mutation cannot carry them
 *
 * `useCreateIssueForm` owns the submit path (container creation, local
 * create, shared-org enqueue) extended with every field the model accepts
 * (`priority`, `labelIds`, `dueDate`, `estimate`, `cycleId`, `parentId`,
 * `blockedBy`, `status`). Submit on ⌘↵ / Ctrl+Enter.
 */

import {
  BoldIcon,
  CalendarIcon,
  ChevronDownIcon,
  CodeIcon,
  Heading2Icon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  ListTodoIcon,
  Loader2Icon,
  QuoteIcon,
  SparklesIcon,
  StrikethroughIcon,
  TagsIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { createIssue } from "@/lib/db/issues"
import { createIssueProject, listTakenProjectKeys } from "@/lib/db/issue-projects"
import { getCollabWorkspace } from "@/lib/db/collab-workspace-mirror"
import { enqueueCollabMutation } from "@/lib/db/mobile-outbound-queue"
import { buildHeadlessTurnLlmClient } from "@/lib/ai/headless-turn-llm-client"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import {
  draftIssueDescription,
  improveIssueDescription,
  suggestIssueMetadata,
  suggestIssueRelations,
  suggestIssueTitle,
} from "@/lib/issues/ai-issue-assist"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { cn } from "@/lib/utils"
import type { IssueCycle } from "@/types/issues"
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  statusCategoryOf,
  type IssueActor,
  type IssuePriority,
  type IssueProject,
  type IssueStatus,
} from "@/types/issues"
import { FULL_ISSUE_CAPABILITIES, type UnifiedIssueItem } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { AssigneePicker } from "./assignee-picker"
import { IssuePriorityIcon, IssueStatusIcon } from "./issue-glyphs"
import { IssueCardVisual } from "./board/issue-card"
import { IssuePicker, type IssuePickerCandidate } from "./planning/issue-picker"
import {
  EMPTY_PROJECT_IDENTITY,
  ProjectIdentityFields,
  resolveProjectIdentity,
  type ProjectIdentityState,
} from "./projects/project-identity-fields"

const NEW_PROJECT_VALUE = "__new__"
const NO_CYCLE_VALUE = "__none__"

// ── shared form model ───────────────────────────────────────────────────────

export interface CreateIssuePageProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Owning workspace id. */
  projectId: string
  projects: readonly IssueProject[]
  /** Column the user clicked "+" on. */
  status?: IssueStatus
  /** Create as a sub-issue of this local issue. */
  parent?: { id: string; identifier: string; issueProjectId: string }
  /** Plan the new issue into this cycle. */
  cycleId?: string
  onCreated?: (issueId: string) => void
  /** Writable local labels, for the labels menu. */
  labels?: readonly LabelRow[]
  /** Workspace cycles, for the cycle picker. */
  cycles?: readonly IssueCycle[]
  /** Board-visible issues, for the parent/blocker pickers and `#` references. */
  issues?: readonly UnifiedIssueItem[]
}

interface FormState {
  title: string
  description: string
  status: IssueStatus
  priority: IssuePriority
  assignee: IssueActor | null
  labelIds: string[]
  /** Explicit container pick only; the effective id is `selectedProjectId`. */
  issueProjectId: string
  cycleId: string
  dueDate: number | undefined
  estimate: number | undefined
  /** Local issue id of the parent; seeded from the sub-issue flow. */
  parentId: string
  /** Local issue ids that block this one (relation the model already stores). */
  blockedByIds: string[]
}

function initialForm(props: CreateIssuePageProps): FormState {
  return {
    title: "",
    description: "",
    status: props.status ?? "backlog",
    priority: "none",
    assignee: null,
    labelIds: [],
    issueProjectId: "",
    cycleId: props.cycleId ?? "",
    dueDate: undefined,
    estimate: undefined,
    parentId: props.parent?.id ?? "",
    blockedByIds: [],
  }
}

/**
 * The form half of every create surface: field state, container-creation
 * mode, shared-org destination, validation and submit. Mirrors
 * `create-issue-dialog.tsx`'s submit exactly, extended with the fields the
 * model already accepts (`priority`, `labelIds`, `dueDate`, `estimate`,
 * `cycleId` — `parentId` and `status` were already there).
 */
function useCreateIssueForm(props: CreateIssuePageProps) {
  const t = useTranslations("issues")
  const [form, setForm] = useState<FormState>(() => initialForm(props))
  const [creatingProject, setCreatingProject] = useState(false)
  const [identity, setIdentity] = useState<ProjectIdentityState>(EMPTY_PROJECT_IDENTITY)
  const [takenKeys, setTakenKeys] = useState<ReadonlySet<string>>(new Set())
  const [sharedOrgId, setSharedOrgId] = useState<string | null>(null)
  const [destination, setDestination] = useState<"local" | "shared">("local")
  const [createAnother, setCreateAnother] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const needsProject = props.projects.length === 0 || creatingProject
  const patch = useCallback((next: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...next }))
  }, [])

  useEffect(() => {
    if (!props.open || !needsProject) return
    void listTakenProjectKeys().then(setTakenKeys)
  }, [props.open, needsProject])

  useEffect(() => {
    if (!props.open) return
    void getCollabWorkspace(props.projectId).then((workspace) =>
      setSharedOrgId(workspace?.orgId ?? null)
    )
  }, [props.open, props.projectId])

  const identityVerdict = useMemo(
    () => resolveProjectIdentity(identity, takenKeys),
    [identity, takenKeys]
  )
  /**
   * Falls back to the parent's container, then the first one, until the user
   * picks another — the same lazy default the real dialog derives, so a
   * `projects` list that loads after the surface opens still resolves.
   */
  const selectedProjectId =
    form.issueProjectId || props.parent?.issueProjectId || (props.projects[0]?.id ?? "")
  const canSubmit =
    form.title.trim().length > 0 &&
    !busy &&
    (needsProject ? identityVerdict.valid : Boolean(selectedProjectId))

  /** Fields the shared-org mutation understands; the rest stay local-only. */
  async function submit() {
    setBusy(true)
    setError(null)
    try {
      if (destination === "shared") {
        if (!sharedOrgId || !selectedProjectId) throw new Error(t("create.sharedUnavailable"))
        await enqueueCollabMutation({
          command: "collab_issue_create",
          orgId: sharedOrgId,
          entityType: "issue",
          entityId: `new:${props.projectId}:${selectedProjectId}`,
          payload: {
            workspaceId: props.projectId,
            issueProjectId: selectedProjectId,
            title: form.title,
            ...(form.description.trim() ? { body: form.description.trim() } : {}),
            ...(form.assignee?.id ? { assignee: form.assignee } : {}),
            status: form.status,
          },
          label: form.title,
        })
      } else {
        const containerId = needsProject
          ? (
              await createIssueProject({
                projectId: props.projectId,
                name: identity.name.trim(),
                key: identityVerdict.key || undefined,
              })
            ).id
          : selectedProjectId

        const issue = await createIssue({
          projectId: props.projectId,
          issueProjectId: containerId,
          title: form.title,
          ...(form.description.trim() ? { description: form.description.trim() } : {}),
          ...(form.assignee ? { assignee: form.assignee } : {}),
          status: form.status,
          priority: form.priority,
          labelIds: form.labelIds,
          createdBy: { kind: "human" },
          ...(form.parentId ? { parentId: form.parentId } : {}),
          ...(form.blockedByIds.length > 0 ? { blockedBy: form.blockedByIds } : {}),
          ...(form.cycleId ? { cycleId: form.cycleId } : {}),
          ...(form.dueDate !== undefined ? { dueDate: form.dueDate } : {}),
          ...(form.estimate !== undefined ? { estimate: form.estimate } : {}),
        })
        props.onCreated?.(issue.id)
      }

      const resetTo = createAnother
        ? { ...initialForm(props), status: form.status, issueProjectId: form.issueProjectId }
        : initialForm(props)
      setForm(resetTo)
      setIdentity(EMPTY_PROJECT_IDENTITY)
      setCreatingProject(false)
      if (!createAnother) props.onOpenChange(false)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  return {
    t,
    form,
    patch,
    creatingProject,
    setCreatingProject,
    identity,
    setIdentity,
    sharedOrgId,
    destination,
    setDestination,
    createAnother,
    setCreateAnother,
    busy,
    error,
    needsProject,
    identityVerdict,
    takenKeys,
    selectedProjectId,
    canSubmit,
    submit,
  }
}

type Form = ReturnType<typeof useCreateIssueForm>

// ── shared field controls ───────────────────────────────────────────────────

function StatusField({ form, id, compact }: { form: Form; id: string; compact?: boolean }) {
  const t = form.t
  return (
    <Select
      value={form.form.status}
      onValueChange={(value) => form.patch({ status: value as IssueStatus })}
    >
      <SelectTrigger
        id={id}
        data-testid="create-field-status"
        className={compact ? "h-7 w-auto gap-1 px-2 text-xs" : "h-9 w-full"}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ISSUE_STATUSES.map((status) => (
          <SelectItem key={status} value={status}>
            <span className="flex items-center gap-1.5">
              <IssueStatusIcon status={status} />
              {t(`status.${status}`)}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function PriorityField({ form, id, compact }: { form: Form; id: string; compact?: boolean }) {
  const t = form.t
  return (
    <Select
      value={form.form.priority}
      onValueChange={(value) => form.patch({ priority: value as IssuePriority })}
    >
      <SelectTrigger
        id={id}
        data-testid="create-field-priority"
        className={compact ? "h-7 w-auto gap-1 px-2 text-xs" : "h-9 w-full"}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ISSUE_PRIORITIES.map((priority) => (
          <SelectItem key={priority} value={priority}>
            <span className="flex items-center gap-1.5">
              <IssuePriorityIcon priority={priority} className="size-3.5" />
              {t(`priority.${priority}`)}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function LabelsField({
  form,
  labels,
  compact,
}: {
  form: Form
  labels: readonly LabelRow[]
  compact?: boolean
}) {
  const t = form.t
  // No label catalogue → no field: an empty menu is worse than no affordance.
  if (labels.length === 0) return null
  const toggle = (id: string, checked: boolean) =>
    form.patch({
      labelIds: checked
        ? [...form.form.labelIds, id]
        : form.form.labelIds.filter((candidate) => candidate !== id),
    })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="create-field-labels"
          className={cn(
            "inline-flex items-center rounded-md border border-input bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
            compact ? "h-7 gap-1.5 px-2 text-xs" : "h-9 w-full justify-between gap-1.5 px-3 text-sm"
          )}
        >
          <span className="inline-flex items-center gap-1.5">
            <TagsIcon className="size-3.5" />
            {form.form.labelIds.length > 0 ? (
              <span className="text-foreground">{form.form.labelIds.length}</span>
            ) : (
              t("detail.labels")
            )}
          </span>
          {!compact ? <ChevronDownIcon className="size-3.5 opacity-50" /> : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {labels.map((label) => (
          <DropdownMenuCheckboxItem
            key={label.id}
            checked={form.form.labelIds.includes(label.id)}
            onCheckedChange={(checked) => toggle(label.id, checked === true)}
            onSelect={(event) => event.preventDefault()}
            data-testid={`create-field-label-${label.id}`}
          >
            <span className="flex items-center gap-1.5">
              {label.color ? (
                <span className="size-2.5 rounded-full" style={{ backgroundColor: label.color }} />
              ) : null}
              {label.name}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function CycleField({
  form,
  cycles,
  compact,
}: {
  form: Form
  cycles: readonly IssueCycle[]
  compact?: boolean
}) {
  const t = form.t
  return (
    <Select
      value={form.form.cycleId || NO_CYCLE_VALUE}
      onValueChange={(value) => form.patch({ cycleId: value === NO_CYCLE_VALUE ? "" : value })}
    >
      <SelectTrigger
        data-testid="create-field-cycle"
        className={compact ? "h-7 w-auto gap-1 px-2 text-xs" : "h-9 w-full"}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_CYCLE_VALUE}>{t("planning.noCycle")}</SelectItem>
        {cycles.map((cycle) => (
          <SelectItem key={cycle.id} value={cycle.id}>
            {cycle.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function DueDateField({ form, compact }: { form: Form; compact?: boolean }) {
  const t = form.t
  const selected = form.form.dueDate !== undefined ? new Date(form.form.dueDate) : undefined
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="create-field-due"
          className={cn(
            "inline-flex items-center rounded-md border border-input bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
            compact ? "h-7 gap-1.5 px-2 text-xs" : "h-9 w-full justify-between gap-1.5 px-3 text-sm"
          )}
        >
          <span className="inline-flex items-center gap-1.5">
            <CalendarIcon className="size-3.5" />
            {selected ? (
              <span className="text-foreground tabular-nums">
                {selected.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
            ) : (
              t("planning.dueDate")
            )}
          </span>
          {!compact ? <ChevronDownIcon className="size-3.5 opacity-50" /> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <div className="flex gap-1 border-b p-1.5" data-testid="create-due-presets">
          {([0, 1, 7] as const).map((days) => (
            <button
              key={days}
              type="button"
              onClick={() =>
                form.patch({
                  dueDate: new Date(Date.now() + days * 86_400_000).setHours(23, 59, 59, 0),
                })
              }
              data-testid={`create-due-preset-${days}`}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {t(`create.dueQuick.${days}`)}
            </button>
          ))}
        </div>
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(date) =>
            form.patch({ dueDate: date ? new Date(date).setHours(23, 59, 59, 0) : undefined })
          }
        />
        {selected ? (
          <div className="border-t p-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-xs"
              onClick={() => form.patch({ dueDate: undefined })}
              data-testid="create-field-due-clear"
            >
              {t("planning.clearDueDate")}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function EstimateField({ form, compact }: { form: Form; compact?: boolean }) {
  const t = form.t
  const input = (
    <Input
      type="number"
      min={0}
      step={1}
      value={form.form.estimate ?? ""}
      onChange={(event) =>
        form.patch({
          estimate: event.target.value === "" ? undefined : Number(event.target.value),
        })
      }
      placeholder={t("planning.estimatePlaceholder")}
      aria-label={t("planning.estimate")}
      data-testid="create-field-estimate"
      className={compact ? "h-7 w-16 px-2 text-xs" : "w-full"}
    />
  )
  if (compact) return input
  return (
    <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1">{input}</div>
      {/* Fibonacci-style quick points, Linear-style. */}
      {([1, 2, 3, 5, 8] as const).map((points) => (
        <button
          key={points}
          type="button"
          onClick={() =>
            form.patch({ estimate: form.form.estimate === points ? undefined : points })
          }
          aria-label={`${points}`}
          data-testid={`create-estimate-preset-${points}`}
          className={cn(
            "flex h-9 w-8 shrink-0 items-center justify-center rounded-md border border-input text-xs tabular-nums",
            form.form.estimate === points
              ? "border-foreground/40 bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
        >
          {points}
        </button>
      ))}
    </div>
  )
}

/** Container select with the "new container" escape row — the real dialog's flow. */
function ProjectField({
  form,
  id,
  compact,
}: {
  form: FormWithProps
  id: string
  compact?: boolean
}) {
  const t = form.t
  return (
    <Select
      value={form.selectedProjectId}
      onValueChange={(next) => {
        if (next === NEW_PROJECT_VALUE) {
          form.setDestination("local")
          form.setCreatingProject(true)
          return
        }
        form.patch({ issueProjectId: next })
      }}
    >
      <SelectTrigger
        id={id}
        data-testid="create-issue-project"
        className={compact ? "h-7 w-auto gap-1 px-2 text-xs" : "h-9 w-full"}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {form.props.projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.name} ({project.key})
          </SelectItem>
        ))}
        <SelectItem value={NEW_PROJECT_VALUE} data-testid="create-issue-project-new">
          {t("create.newProject")}
        </SelectItem>
      </SelectContent>
    </Select>
  )
}

// `props` rides on the form so shared controls can read projects/labels/cycles
// without threading them through every call site.
type FormWithProps = Form & { props: CreateIssuePageProps }

function useForm(props: CreateIssuePageProps): FormWithProps {
  const form = useCreateIssueForm(props)
  return { ...form, props }
}

// ── D · page (GitHub-style) ─────────────────────────────────────────────────

/**
 * Cursor-aware markdown edit for the Write textarea. Wrap-actions mark the
 * selected range (or drop a placeholder when nothing is selected); line
 * actions prefix every line the selection touches, mirroring GitHub's
 * toolbar. Returns the next value plus the selection the caller should
 * restore after React re-renders the textarea.
 */
export type MarkdownAction =
  | "heading"
  | "bold"
  | "italic"
  | "strikethrough"
  | "code"
  | "link"
  | "bullet"
  | "number"
  | "task"
  | "quote"

export interface MarkdownEdit {
  value: string
  selectionStart: number
  selectionEnd: number
}

const WRAP_MARK: Partial<Record<MarkdownAction, [string, string]>> = {
  bold: ["**", "**"],
  italic: ["*", "*"],
  strikethrough: ["~~", "~~"],
  code: ["`", "`"],
}

function linePrefix(action: MarkdownAction, index: number): string {
  switch (action) {
    case "heading":
      return "## "
    case "bullet":
      return "- "
    case "number":
      return `${index + 1}. `
    case "task":
      return "- [ ] "
    case "quote":
      return "> "
    default:
      return ""
  }
}

export function applyMarkdownFormat(
  value: string,
  start: number,
  end: number,
  action: MarkdownAction
): MarkdownEdit {
  if (action === "link") {
    const selected = value.slice(start, end)
    const text = selected || "text"
    const insert = `[${text}](url)`
    const next = value.slice(0, start) + insert + value.slice(end)
    // Caret lands inside the (url) so typing replaces it.
    const urlStart = start + text.length + 3
    return { value: next, selectionStart: urlStart, selectionEnd: urlStart + 3 }
  }

  const wrap = WRAP_MARK[action]
  if (wrap) {
    const [open, close] = wrap
    const selected = value.slice(start, end)
    const next = value.slice(0, start) + open + selected + close + value.slice(end)
    return selected
      ? {
          value: next,
          selectionStart: start + open.length,
          selectionEnd: start + open.length + selected.length,
        }
      : { value: next, selectionStart: start + open.length, selectionEnd: start + open.length }
  }

  // Line actions: prefix each selected line; skip lines already carrying a
  // list/heading marker so applying twice doesn't double-prefix.
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1
  const lineEndIdx = value.indexOf("\n", end)
  const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx
  const block = value.slice(lineStart, lineEnd)
  const lines = block.split("\n")
  const already = /^\s*(#{1,6}\s|[-*+]\s|[-*+]\s\[.\]\s|\d+\.\s|>\s)/
  const nextLines = lines.map((line, i) =>
    line.trim().length === 0 || already.test(line) ? line : linePrefix(action, i) + line
  )
  const next = value.slice(0, lineStart) + nextLines.join("\n") + value.slice(lineEnd)
  return {
    value: next,
    selectionStart: lineStart,
    selectionEnd: lineStart + nextLines.join("\n").length,
  }
}

/** GitHub-style icon toolbar bound to a textarea ref. */
function MarkdownToolbar({
  textareaRef,
  value,
  onChange,
  t,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  value: string
  onChange: (next: string) => void
  t: (key: string) => string
}) {
  const apply = (action: MarkdownAction) => {
    const ta = textareaRef.current
    const start = ta?.selectionStart ?? value.length
    const end = ta?.selectionEnd ?? value.length
    const edit = applyMarkdownFormat(value, start, end, action)
    onChange(edit.value)
    // Restore focus + selection after React commits the new value.
    requestAnimationFrame(() => {
      ta?.focus()
      ta?.setSelectionRange(edit.selectionStart, edit.selectionEnd)
    })
  }
  const buttons: { action: MarkdownAction; icon: ReactNode; testId: string }[] = [
    { action: "heading", icon: <Heading2Icon className="size-3.5" />, testId: "md-heading" },
    { action: "bold", icon: <BoldIcon className="size-3.5" />, testId: "md-bold" },
    { action: "italic", icon: <ItalicIcon className="size-3.5" />, testId: "md-italic" },
    {
      action: "strikethrough",
      icon: <StrikethroughIcon className="size-3.5" />,
      testId: "md-strike",
    },
    { action: "code", icon: <CodeIcon className="size-3.5" />, testId: "md-code" },
    { action: "link", icon: <LinkIcon className="size-3.5" />, testId: "md-link" },
    { action: "bullet", icon: <ListIcon className="size-3.5" />, testId: "md-bullet" },
    { action: "number", icon: <ListOrderedIcon className="size-3.5" />, testId: "md-number" },
    { action: "task", icon: <ListTodoIcon className="size-3.5" />, testId: "md-task" },
    { action: "quote", icon: <QuoteIcon className="size-3.5" />, testId: "md-quote" },
  ]
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b py-1" data-testid="md-toolbar">
      {buttons.map((button) => (
        <button
          key={button.action}
          type="button"
          // Keep the textarea's selection: a plain click steals focus and the
          // browser clears the range before onClick can read it.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => apply(button.action)}
          title={t(`create.toolbar.${button.action}`)}
          aria-label={t(`create.toolbar.${button.action}`)}
          data-testid={button.testId}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {button.icon}
        </button>
      ))}
    </div>
  )
}

/** Sidebar row in the GitHub mould: small caption above the control. */
function PageFieldRow({
  label,
  children,
  testId,
}: {
  label: string
  children: ReactNode
  testId?: string
}) {
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

/**
 * The GitHub "New issue" shape: a wide two-column editor — markdown body with
 * Write/Preview tabs and a relationships row on the left, a metadata sidebar
 * plus a live board-card preview on the right. Adds the two relation fields
 * the model already stores but no create surface exposes (`parentId`,
 * `blockedBy`).
 */
const DRAFT_STORAGE_PREFIX = "issue-create-draft:v1"

interface PageDraft {
  title: string
  description: string
  status: IssueStatus
  priority: IssuePriority
  labelIds: string[]
}

export function CreateIssuePage(props: CreateIssuePageProps) {
  const form = useForm(props)
  const t = form.t
  const [previewing, setPreviewing] = useState(false)
  const [aiBusy, setAiBusy] = useState<string | null>(null)
  /** Issue ids the relations pass flagged as likely duplicates. */
  const [duplicateIds, setDuplicateIds] = useState<string[]>([])
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const extended = form.destination === "local"
  const draftKey = `${DRAFT_STORAGE_PREFIX}:${props.projectId}`

  /**
   * Draft autosave — restore once per open (only into an untouched form),
   * persist debounced on every edit, clear on successful submit. Scoped to
   * the workspace so drafts don't leak between projects.
   */
  const restoredRef = useRef(false)
  useEffect(() => {
    if (!props.open || restoredRef.current) return
    restoredRef.current = true
    try {
      const raw = localStorage.getItem(draftKey)
      if (!raw) return
      const draft = JSON.parse(raw) as Partial<PageDraft>
      const labelIds = (draft.labelIds ?? []).filter((id) =>
        (props.labels ?? []).some((label) => label.id === id)
      )
      if (
        !form.form.title &&
        !form.form.description &&
        (typeof draft.title === "string" || typeof draft.description === "string")
      ) {
        form.patch({
          ...(typeof draft.title === "string" ? { title: draft.title } : {}),
          ...(typeof draft.description === "string" ? { description: draft.description } : {}),
          ...(draft.status && ISSUE_STATUSES.includes(draft.status)
            ? { status: draft.status }
            : {}),
          ...(draft.priority && ISSUE_PRIORITIES.includes(draft.priority)
            ? { priority: draft.priority }
            : {}),
          ...(labelIds.length > 0 ? { labelIds } : {}),
        })
        toast.message(t("create.draftRestored"))
      }
    } catch {
      // A corrupt draft is just dropped — the form stays usable.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore-once-per-open
  }, [props.open])

  useEffect(() => {
    if (!props.open || !restoredRef.current) return
    const handle = setTimeout(() => {
      const { title, description, status, priority, labelIds } = form.form
      try {
        if (!title.trim() && !description.trim()) {
          localStorage.removeItem(draftKey)
        } else {
          const draft: PageDraft = { title, description, status, priority, labelIds }
          localStorage.setItem(draftKey, JSON.stringify(draft))
        }
      } catch {
        // Quota / privacy-mode failures must not break typing.
      }
    }, 400)
    return () => clearTimeout(handle)
  }, [props.open, form.form, draftKey])

  const submitAndClearDraft = async () => {
    const ok = await form.submit()
    if (ok) {
      try {
        localStorage.removeItem(draftKey)
      } catch {
        // ignore
      }
    }
    return ok
  }

  /**
   * Resolve a renderer-side model exactly like the composer wand does:
   * utility client (BYOK key) first, one headless turn over the chat
   * transport as fallback.
   */
  const resolveClient = () => {
    const appSettings = useSettingsStore.getState().settings
    return (
      buildUtilityLlmClient({
        session: null,
        appSettings,
        featureId: "issue-create-assist",
      }) ?? buildHeadlessTurnLlmClient({ session: null, label: "Issue create assist" })
    )
  }

  /**
   * Picker candidates are the board's local rows; a row already claimed as
   * blocker (or picked as parent) is disabled so the same relation can't be
   * entered twice.
   */
  const candidates = useMemo<IssuePickerCandidate[]>(() => {
    const claimed = new Set(form.form.blockedByIds)
    if (form.form.parentId) claimed.add(form.form.parentId)
    return (props.issues ?? [])
      .filter((issue) => issue.kind === "local")
      .map((issue) => ({
        id: issue.sourceId,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        disabled: claimed.has(issue.sourceId),
      }))
  }, [props.issues, form.form.blockedByIds, form.form.parentId])

  const candidatesById = useMemo(
    () => new Map(candidates.map((candidate) => [candidate.id, candidate])),
    [candidates]
  )
  const parentCandidate = form.form.parentId ? candidatesById.get(form.form.parentId) : undefined
  const blockedCandidates = form.form.blockedByIds
    .map((id) => candidatesById.get(id))
    .filter((candidate): candidate is IssuePickerCandidate => Boolean(candidate))

  const runAi = async (intent: "draft" | "improve" | "suggest" | "title" | "relations") => {
    if (aiBusy) return
    const client = resolveClient()
    if (!client) {
      toast.error(t("create.ai.noModel"))
      return
    }
    setAiBusy(intent)
    try {
      if (intent === "draft") {
        const base = form.form.description.trim() ? `${form.form.description.trimEnd()}\n\n` : ""
        const res = await draftIssueDescription(form.form.title, {
          client,
          projectName: props.projects.find((p) => p.id === form.selectedProjectId)?.name,
          // Live-typing effect: mirror each accumulated chunk into the
          // textarea as it streams; the settled (cleaned) text replaces it.
          onAccumulated: (text) => form.patch({ description: base + text }),
        })
        if (res.kind === "text") {
          form.patch({ description: base + res.text })
          toast.success(t("create.ai.applied"))
        } else {
          toast.info(t(`create.ai.skipped.${res.reason}`))
        }
      } else if (intent === "improve") {
        const previous = form.form.description
        const res = await improveIssueDescription(previous, { client })
        if (res.kind === "text") {
          form.patch({ description: res.text })
          toast.success(t("create.ai.applied"), {
            action: {
              label: t("create.ai.undo"),
              onClick: () => form.patch({ description: previous }),
            },
          })
        } else {
          toast.info(t(`create.ai.skipped.${res.reason}`))
        }
      } else if (intent === "suggest") {
        const res = await suggestIssueMetadata(
          {
            title: form.form.title,
            description: form.form.description,
            labelNames: (props.labels ?? []).map((label) => label.name),
          },
          { client }
        )
        if (res.kind === "suggestion") {
          const suggestedIds = new Set(res.suggestion.labelNames)
          const labelIds = (props.labels ?? [])
            .filter((label) => suggestedIds.has(label.name))
            .map((label) => label.id)
          form.patch({
            ...(res.suggestion.priority ? { priority: res.suggestion.priority } : {}),
            ...(res.suggestion.estimate !== undefined ? { estimate: res.suggestion.estimate } : {}),
            ...(labelIds.length > 0
              ? { labelIds: [...new Set([...form.form.labelIds, ...labelIds])] }
              : {}),
          })
          toast.success(t("create.ai.applied"))
        } else {
          toast.info(t(`create.ai.skipped.${res.reason}`))
        }
      } else if (intent === "title") {
        const previous = form.form.title
        const res = await suggestIssueTitle(form.form.description, { client })
        if (res.kind === "text") {
          form.patch({ title: res.text })
          toast.success(
            t("create.ai.applied"),
            previous.trim()
              ? {
                  action: {
                    label: t("create.ai.undo"),
                    onClick: () => form.patch({ title: previous }),
                  },
                }
              : undefined
          )
        } else {
          toast.info(t(`create.ai.skipped.${res.reason}`))
        }
      } else {
        const res = await suggestIssueRelations(
          {
            title: form.form.title,
            description: form.form.description,
            candidates,
          },
          { client }
        )
        if (res.kind === "suggestion") {
          const { parentId, blockedByIds, duplicateIds: dupIds } = res.suggestion
          form.patch({
            ...(parentId && !form.form.parentId ? { parentId } : {}),
            ...(blockedByIds.length > 0
              ? { blockedByIds: [...new Set([...form.form.blockedByIds, ...blockedByIds])] }
              : {}),
          })
          setDuplicateIds(dupIds)
          toast.success(t("create.ai.applied"))
        } else {
          toast.info(t(`create.ai.skipped.${res.reason}`))
        }
      }
    } catch {
      toast.error(t("create.ai.failed"))
    } finally {
      setAiBusy(null)
    }
  }

  /** Static scaffolds — the instant, no-model counterpart of AI draft. */
  const applyTemplate = (key: "bug" | "feature" | "task") => {
    const body = t(`create.templates.${key}Body`)
    form.patch({
      description: form.form.description.trim()
        ? `${form.form.description.trimEnd()}\n\n${body}`
        : body,
    })
    setPreviewing(false)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  /**
   * `#` issue references, GitHub-style: typing `#foo` at the caret opens a
   * filtered picker; Enter/click replaces the `#query` with `DEMO-1 `.
   * Escape dismisses this particular invocation (`dismissedAt` pins the `#`
   * position) — a fresh `#` elsewhere reopens it.
   */
  const [caret, setCaret] = useState(0)
  const [refIndex, setRefIndex] = useState(0)
  const [refDismissedAt, setRefDismissedAt] = useState<number | null>(null)
  const refMatch = useMemo(() => {
    const upto = form.form.description.slice(0, caret)
    const match = /#([A-Za-z0-9_-]*)$/.exec(upto)
    return match ? { query: match[1], at: upto.length - match[0].length } : null
  }, [form.form.description, caret])
  const refSuggestions = useMemo(() => {
    if (!refMatch || !extended) return []
    const query = refMatch.query.toLowerCase()
    return (props.issues ?? [])
      .filter((issue) => issue.kind === "local")
      .filter(
        (issue) =>
          !query ||
          issue.identifier.toLowerCase().includes(query) ||
          issue.title.toLowerCase().includes(query)
      )
      .slice(0, 5)
  }, [refMatch, extended, props.issues])
  const refPanelOpen =
    refSuggestions.length > 0 && refMatch !== null && refMatch.at !== refDismissedAt
  // Reset the highlight when the query text changes — the endorsed
  // render-time "adjust state on prop change" pattern, not an effect.
  const [prevRefQuery, setPrevRefQuery] = useState<string | null>(null)
  if ((refMatch?.query ?? null) !== prevRefQuery) {
    setPrevRefQuery(refMatch?.query ?? null)
    setRefIndex(0)
  }

  const insertIssueRef = (identifier: string) => {
    if (!refMatch) return
    const before = form.form.description.slice(0, refMatch.at)
    const after = form.form.description.slice(caret)
    const insert = `${identifier} `
    const nextCaret = (before + insert).length
    form.patch({ description: before + insert + after })
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const onDescriptionKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!refPanelOpen) return
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setRefIndex((i) => (i + 1) % refSuggestions.length)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setRefIndex((i) => (i - 1 + refSuggestions.length) % refSuggestions.length)
    } else if (event.key === "Enter") {
      event.preventDefault()
      const pick = refSuggestions[refIndex] ?? refSuggestions[0]
      if (pick) insertIssueRef(pick.identifier)
    } else if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      if (refMatch) setRefDismissedAt(refMatch.at)
    }
  }

  /** The card this form currently describes — rendered with the real card. */
  const previewItem = useMemo<UnifiedIssueItem>(() => {
    const container = props.projects.find((project) => project.id === form.selectedProjectId)
    return {
      unifiedId: "create-preview",
      kind: "local",
      sourceId: "create-preview",
      identifier: `${container?.key ?? "—"}-?`,
      title: form.form.title.trim() || t("create.titlePlaceholder"),
      status: form.form.status,
      statusCategory: statusCategoryOf(form.form.status),
      priority: form.form.priority,
      assignee: form.form.assignee ?? undefined,
      labelIds: form.form.labelIds,
      issueProjectId: form.selectedProjectId || undefined,
      order: 0,
      createdAt: 0,
      updatedAt: 0,
      origin: { deepLinkHref: "#" },
      capabilities: FULL_ISSUE_CAPABILITIES,
      parentId: form.form.parentId || undefined,
      blockedBy: form.form.blockedByIds,
      dueDate: form.form.dueDate,
      estimate: form.form.estimate,
      cycleId: form.form.cycleId || undefined,
    }
  }, [props.projects, form.selectedProjectId, form.form, t])
  const previewLabels = (props.labels ?? []).filter((label) =>
    form.form.labelIds.includes(label.id)
  )

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col sm:max-w-[52rem]"
        data-testid="create-page"
      >
        <SheetHeader>
          <SheetTitle>{t("create.title")}</SheetTitle>
          {form.needsProject ? (
            <SheetDescription>{t("create.noProject")}</SheetDescription>
          ) : props.parent ? (
            <SheetDescription data-testid="create-issue-parent">
              {t("create.subIssueOf", { identifier: props.parent.identifier })}
            </SheetDescription>
          ) : null}
        </SheetHeader>

        <div
          className="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-y-auto px-4 pb-2 sm:grid-cols-[minmax(0,1fr)_15rem] sm:overflow-hidden"
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && form.canSubmit) {
              event.preventDefault()
              void submitAndClearDraft()
            }
          }}
        >
          {/* ── left: the document ── */}
          <div className="flex min-w-0 flex-col gap-4 sm:min-h-0 sm:overflow-y-auto sm:pr-2 sm:[scrollbar-gutter:stable]">
            <Input
              value={form.form.title}
              onChange={(event) => form.patch({ title: event.target.value })}
              placeholder={t("create.titlePlaceholder")}
              aria-label={t("create.titleLabel")}
              autoFocus
              className="h-12 rounded-none border-0 bg-transparent px-0 text-xl font-semibold shadow-none focus-visible:ring-0 dark:bg-transparent"
              data-testid="create-issue-title"
            />

            <div
              className="flex flex-col rounded-md border transition-colors focus-within:border-ring sm:min-h-40 sm:flex-1"
              data-testid="create-description-editor"
            >
              <div className="flex items-center justify-between gap-2 border-b">
                <div
                  className="flex gap-1"
                  role="tablist"
                  aria-label={t("create.descriptionLabel")}
                >
                  {(["write", "preview"] as const).map((tab) => {
                    const active = previewing === (tab === "preview")
                    return (
                      <button
                        key={tab}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => setPreviewing(tab === "preview")}
                        data-testid={`create-tab-${tab}`}
                        className={cn(
                          "-mb-px border-b-2 px-3 py-1.5 text-sm",
                          active
                            ? "border-foreground font-medium text-foreground"
                            : "border-transparent text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {t(`create.${tab}`)}
                      </button>
                    )
                  })}
                </div>
                <div className="flex shrink-0 items-center gap-1 pb-0.5">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        data-testid="create-templates"
                        className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        {t("create.templates.label")}
                        <ChevronDownIcon className="size-3" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {(["bug", "feature", "task"] as const).map((key) => (
                        <DropdownMenuItem
                          key={key}
                          onSelect={() => applyTemplate(key)}
                          data-testid={`create-template-${key}`}
                        >
                          {t(`create.templates.${key}`)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        data-testid="create-ai"
                        aria-label={t("create.ai.label")}
                        disabled={aiBusy !== null}
                        className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                      >
                        {aiBusy ? (
                          <Loader2Icon className="size-3.5 animate-spin" />
                        ) : (
                          <SparklesIcon className="size-3.5" />
                        )}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() => void runAi("draft")}
                        disabled={!form.form.title.trim()}
                        data-testid="create-ai-draft"
                      >
                        {t("create.ai.draft")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => void runAi("improve")}
                        disabled={!form.form.description.trim()}
                        data-testid="create-ai-improve"
                      >
                        {t("create.ai.improve")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => void runAi("suggest")}
                        disabled={!form.form.title.trim() && !form.form.description.trim()}
                        data-testid="create-ai-suggest"
                      >
                        {t("create.ai.suggest")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => void runAi("title")}
                        disabled={!form.form.description.trim()}
                        data-testid="create-ai-title"
                      >
                        {t("create.ai.title")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => void runAi("relations")}
                        disabled={candidates.length === 0}
                        data-testid="create-ai-relations"
                      >
                        {t("create.ai.relations")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              {/* Format toolbar gets its own row — a narrow column wraps the
                  buttons instead of clipping them (same two-row layout as
                  GitHub's editor chrome). */}
              {!previewing ? (
                <MarkdownToolbar
                  textareaRef={textareaRef}
                  value={form.form.description}
                  onChange={(description) => form.patch({ description })}
                  t={t}
                />
              ) : null}
              {previewing ? (
                <div
                  className="min-h-64 rounded-b-md px-1 py-3 sm:min-h-0 sm:flex-1 sm:overflow-y-auto"
                  data-testid="create-description-preview"
                >
                  {form.form.description.trim() ? (
                    <MarkdownRenderer content={form.form.description} rhythm="document" />
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("create.nothingToPreview")}</p>
                  )}
                </div>
              ) : (
                <div className="relative flex flex-col sm:min-h-0 sm:flex-1">
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <Textarea
                      ref={textareaRef}
                      value={form.form.description}
                      onChange={(event) => {
                        form.patch({ description: event.target.value })
                        setCaret(event.target.selectionStart ?? 0)
                      }}
                      onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
                      onKeyDown={onDescriptionKeyDown}
                      placeholder={t("create.descriptionPlaceholder")}
                      rows={12}
                      className="min-h-64 resize-y rounded-t-none border-0 border-t-0 bg-transparent shadow-none focus-visible:ring-0 sm:min-h-full sm:resize-none dark:bg-transparent"
                      data-testid="create-issue-description"
                    />
                  </div>
                  {refPanelOpen ? (
                    <div
                      className="absolute right-2 top-2 z-10 w-64 overflow-hidden rounded-md border bg-popover shadow-md"
                      data-testid="issue-ref-panel"
                      role="listbox"
                      aria-label={t("create.issueRef")}
                    >
                      {refSuggestions.map((issue, index) => (
                        <button
                          key={issue.sourceId}
                          type="button"
                          role="option"
                          aria-selected={index === refIndex}
                          data-testid={`issue-ref-option-${issue.sourceId}`}
                          // Same focus-preservation trick as the toolbar.
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => insertIssueRef(issue.identifier)}
                          className={cn(
                            "flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-xs",
                            index === refIndex ? "bg-accent" : "hover:bg-accent/60"
                          )}
                        >
                          <span className="shrink-0 font-mono text-muted-foreground">
                            {issue.identifier}
                          </span>
                          <span className="truncate">{issue.title}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
            <p className="-mt-2 text-right text-[11px] text-muted-foreground">
              {t("create.markdownHint")}
            </p>

            {extended && candidates.length > 0 ? (
              <div className="flex flex-col gap-2" data-testid="create-relationships">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("create.relationships")}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <IssuePicker
                    candidates={candidates}
                    value={form.form.parentId || undefined}
                    onPick={(id) => form.patch({ parentId: id })}
                    triggerLabel={t("planning.pickParent")}
                    testId="create-field-parent"
                  >
                    <button
                      type="button"
                      data-testid="create-field-parent"
                      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-input px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      {parentCandidate ? (
                        <span className="font-mono text-foreground">
                          {parentCandidate.identifier}
                        </span>
                      ) : (
                        t("planning.parent")
                      )}
                    </button>
                  </IssuePicker>
                  {form.form.parentId ? (
                    <button
                      type="button"
                      onClick={() => form.patch({ parentId: "" })}
                      aria-label={t("planning.clearParent")}
                      data-testid="create-field-parent-clear"
                      className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <XIcon className="size-3" />
                    </button>
                  ) : null}

                  <IssuePicker
                    candidates={candidates}
                    onPick={(id) => form.patch({ blockedByIds: [...form.form.blockedByIds, id] })}
                    triggerLabel={t("planning.addBlocker")}
                    testId="create-field-blockedby"
                  >
                    <button
                      type="button"
                      data-testid="create-field-blockedby"
                      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-input px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      + {t("planning.blockedBy")}
                    </button>
                  </IssuePicker>
                  {blockedCandidates.map((candidate) => (
                    <span
                      key={candidate.id}
                      className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2 font-mono text-xs"
                      data-testid={`create-blockedby-chip-${candidate.id}`}
                    >
                      {candidate.identifier}
                      <button
                        type="button"
                        onClick={() =>
                          form.patch({
                            blockedByIds: form.form.blockedByIds.filter(
                              (id) => id !== candidate.id
                            ),
                          })
                        }
                        aria-label={t("planning.removeBlocker")}
                        data-testid={`create-blockedby-remove-${candidate.id}`}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <XIcon className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {duplicateIds.length > 0 ? (
              <div
                className="flex flex-wrap items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs"
                data-testid="create-ai-duplicates"
              >
                <TriangleAlertIcon className="size-3.5 shrink-0 text-amber-500" />
                <span className="text-muted-foreground">{t("create.ai.duplicates")}</span>
                {duplicateIds.map((id) => {
                  const issue = candidatesById.get(id)
                  return (
                    <span
                      key={id}
                      className="inline-flex items-center rounded bg-background px-1.5 py-0.5 font-mono"
                      data-testid={`create-duplicate-${id}`}
                    >
                      {issue ? `${issue.identifier} ${issue.title}` : id}
                    </span>
                  )
                })}
                <button
                  type="button"
                  onClick={() => setDuplicateIds([])}
                  aria-label={t("create.ai.dismiss")}
                  data-testid="create-duplicates-dismiss"
                  className="ml-auto flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            ) : null}

            {form.error ? (
              <p className="text-sm text-destructive" data-testid="create-issue-error">
                {form.error}
              </p>
            ) : null}
          </div>

          {/* ── right: metadata sidebar ── */}
          <aside className="flex min-w-0 flex-col gap-3 border-t pt-4 sm:min-h-0 sm:overflow-y-auto sm:border-l sm:border-t-0 sm:pl-4 sm:pr-2 sm:pt-0 sm:[scrollbar-gutter:stable]">
            <PageFieldRow label={t("create.cardPreview")} testId="create-card-preview">
              {/* Framed as a mini board column — the card reads as "how this
                  will look on the board", not a floating orphan. */}
              <div className="rounded-lg border bg-muted/40 p-2">
                <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[11px] font-medium text-muted-foreground">
                  <IssueStatusIcon status={form.form.status} />
                  {t(`status.${form.form.status}`)}
                  <span className="rounded-full bg-background px-1.5 tabular-nums">1</span>
                </div>
                <div className="pointer-events-none">
                  <IssueCardVisual
                    item={previewItem}
                    labels={previewLabels}
                    projectName={
                      props.projects.find((project) => project.id === form.selectedProjectId)?.name
                    }
                  />
                </div>
              </div>
            </PageFieldRow>

            {form.sharedOrgId && props.projects.length > 0 ? (
              <PageFieldRow label={t("create.destinationLabel")}>
                <Select
                  value={form.destination}
                  onValueChange={(value) => form.setDestination(value as "local" | "shared")}
                >
                  <SelectTrigger data-testid="create-issue-destination" className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">{t("create.destinationLocal")}</SelectItem>
                    <SelectItem value="shared">{t("create.destinationShared")}</SelectItem>
                  </SelectContent>
                </Select>
              </PageFieldRow>
            ) : null}

            <PageFieldRow label={t("detail.status")}>
              <StatusField form={form} id="page-status" />
            </PageFieldRow>
            <PageFieldRow label={t("detail.priority")}>
              <PriorityField form={form} id="page-priority" />
            </PageFieldRow>
            <PageFieldRow label={t("detail.assignee")}>
              {/* w-fit trigger by default — force full-width to match rows. */}
              <div className="[&_[data-slot=select-trigger]]:w-full">
                <AssigneePicker
                  value={form.form.assignee}
                  onChange={(actor) => form.patch({ assignee: actor })}
                  data-testid="create-issue-assignee"
                />
              </div>
              {form.form.assignee?.kind !== "human" ? (
                <button
                  type="button"
                  onClick={() =>
                    form.patch({ assignee: { kind: "human", label: t("actor.human") } })
                  }
                  data-testid="create-assign-me"
                  className="w-fit text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {t("create.assignMe")}
                </button>
              ) : null}
            </PageFieldRow>

            {extended ? (
              <>
                <PageFieldRow label={t("detail.labels")}>
                  <div className="flex flex-col gap-1.5">
                    <LabelsField form={form} labels={props.labels ?? []} />
                    {form.form.labelIds.length > 0 ? (
                      <div className="flex flex-wrap gap-1" data-testid="create-label-chips">
                        {previewLabels.map((label) => (
                          <span
                            key={label.id}
                            className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[11px]"
                          >
                            {label.color ? (
                              <span
                                className="size-2 rounded-full"
                                style={{ backgroundColor: label.color }}
                              />
                            ) : null}
                            {label.name}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </PageFieldRow>
                <PageFieldRow label={t("create.projectLabel")}>
                  {form.needsProject ? (
                    <div className="flex flex-col gap-1.5">
                      {props.projects.length > 0 ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-fit px-0 text-xs"
                          onClick={() => form.setCreatingProject(false)}
                          data-testid="create-issue-project-cancel-new"
                        >
                          {t("create.pickExistingProject")}
                        </Button>
                      ) : null}
                      <ProjectIdentityFields
                        value={form.identity}
                        onChange={form.setIdentity}
                        takenKeys={form.takenKeys}
                        idPrefix="create-issue-project"
                        disabled={form.busy}
                      />
                    </div>
                  ) : (
                    <ProjectField form={form} id="page-project" />
                  )}
                </PageFieldRow>
                <PageFieldRow label={t("planning.cycle")}>
                  <CycleField form={form} cycles={props.cycles ?? []} />
                </PageFieldRow>
                <PageFieldRow label={t("planning.dueDate")}>
                  <DueDateField form={form} />
                </PageFieldRow>
                <PageFieldRow label={t("planning.estimate")}>
                  <EstimateField form={form} />
                </PageFieldRow>
              </>
            ) : null}
          </aside>
        </div>

        <SheetFooter className="flex-row items-center justify-between border-t sm:justify-between">
          <label
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-testid="create-another-label"
          >
            <Checkbox
              checked={form.createAnother}
              onCheckedChange={(checked) => form.setCreateAnother(checked === true)}
              data-testid="create-another"
            />
            {t("create.createAnother")}
          </label>
          <div className="flex items-center gap-2">
            <kbd
              className="hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline"
              data-testid="create-submit-hint"
            >
              {t("create.submitHint")}
            </kbd>
            <Button variant="ghost" onClick={() => props.onOpenChange(false)} disabled={form.busy}>
              {t("create.cancel")}
            </Button>
            <Button
              onClick={() => void submitAndClearDraft()}
              disabled={!form.canSubmit}
              data-testid="create-issue-submit"
            >
              {t("create.submit")}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
