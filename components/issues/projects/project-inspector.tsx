"use client"

/**
 * The selected container, editable.
 *
 * Every field here was read-only. `updateIssueProject` accepts eight of them —
 * name, description, status, priority, lead, start date, target date, icon —
 * and had zero callers anywhere in the app, so a container could be created
 * and then never changed. The description was the sharpest case: it is shared
 * with agents as context, and the panel showed a hint telling the user about
 * a description they had no way to write.
 *
 * `key` stays read-only on purpose, and says why: every printed identifier
 * (`MERC-2`) embeds it, so changing it orphans them all.
 */

import { FolderGitIcon, FolderIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import {
  EMPTY_ISSUE_PROJECT_PROGRESS,
  type IssueProjectProgress,
} from "@/lib/issues/project-progress"
import type { IssueProjectUpdatePatch } from "@/lib/db/issue-projects"
import { ISSUE_PRIORITIES, ISSUE_PROJECT_STATUSES, type IssueProject } from "@/types/issues"
import { IssueTextEditor } from "../editors/issue-text-editor"
import { IssuePriorityIcon } from "../issue-glyphs"

export interface ProjectInspectorProps {
  project: IssueProject
  progress?: IssueProjectProgress
  onPatch: (patch: IssueProjectUpdatePatch) => void
  onClose: () => void
  onAddResource: () => void
  onRemoveResource: (index: number) => void
  onRequestDelete: () => void
  /** Jumps to `/issues` pre-filtered to this container. */
  onOpenIssues: () => void
}

export function ProjectInspector({
  project,
  progress,
  onPatch,
  onClose,
  onAddResource,
  onRemoveResource,
  onRequestDelete,
  onOpenIssues,
}: ProjectInspectorProps) {
  const t = useTranslations("issues")
  // One fallback, so the four read sites below cannot drift apart on what
  // "no progress yet" means.
  const tally = progress ?? EMPTY_ISSUE_PROJECT_PROGRESS

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="project-inspector">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <IconPicker value={project.icon} onChange={(icon) => onPatch({ icon })} />
        <div className="min-w-0 flex-1">
          <IssueTextEditor
            value={project.name}
            onCommit={(name) => onPatch({ name })}
            required
            ariaLabel={t("projects.nameLabel")}
            testId="project-name"
            className="-mx-2 text-sm font-semibold"
          />
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} data-testid="project-inspector-close">
          <XIcon className="size-4" />
          <span className="sr-only">{t("detail.close")}</span>
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 text-sm">
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("detail.properties")}
          </h3>

          <Row label={t("projects.keyLabel")}>
            <span className="inline-flex items-center gap-2">
              <Badge variant="outline" className="font-mono text-[10px]">
                {project.key}
              </Badge>
              <span className="text-xs text-muted-foreground">{t("projects.keyImmutable")}</span>
            </span>
          </Row>

          <Row label={t("detail.status")}>
            <PickerMenu
              testId="project-status"
              current={t(`projects.status.${project.status}`)}
              options={ISSUE_PROJECT_STATUSES.map((status) => ({
                id: status,
                label: t(`projects.status.${status}`),
                onSelect: () => onPatch({ status }),
                checked: project.status === status,
              }))}
            />
          </Row>

          <Row label={t("detail.priority")}>
            <PickerMenu
              testId="project-priority"
              current={t(`priority.${project.priority}`)}
              icon={<IssuePriorityIcon priority={project.priority} />}
              options={ISSUE_PRIORITIES.map((priority) => ({
                id: priority,
                label: t(`priority.${priority}`),
                icon: <IssuePriorityIcon priority={priority} />,
                onSelect: () => onPatch({ priority }),
                checked: project.priority === priority,
              }))}
            />
          </Row>

          <Row label={t("projects.lead")}>
            <IssueTextEditor
              value={project.lead?.label ?? ""}
              onCommit={(label) =>
                // A lead is a display name here, not a dispatch target: unlike
                // an assignee, nothing is ever run on their behalf, so binding
                // it to the Character roster would refuse names that are
                // perfectly valid to record.
                onPatch({ lead: label.trim() ? { kind: "human", label: label.trim() } : null })
              }
              placeholder={t("actor.noLead")}
              ariaLabel={t("projects.lead")}
              testId="project-lead"
              className="-mx-2"
            />
          </Row>

          <Row label={t("projects.startDate")}>
            <DateField
              value={project.startDate}
              onChange={(startDate) => onPatch({ startDate })}
              testId="project-start-date"
              ariaLabel={t("projects.startDate")}
            />
          </Row>

          <Row label={t("projects.targetDate")}>
            <DateField
              value={project.targetDate}
              onChange={(targetDate) => onPatch({ targetDate })}
              testId="project-target-date"
              ariaLabel={t("projects.targetDate")}
            />
          </Row>
        </section>

        <Separator />

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("projects.progress")}
          </h3>
          <div className="flex items-center gap-2">
            <Progress
              value={tally.ratio * 100}
              className="h-2 flex-1"
              aria-label={t("projects.progress")}
            />
            <span className="text-xs tabular-nums text-muted-foreground">
              {t("projects.progressCount", {
                completed: tally.completed,
                total: tally.denominator,
              })}
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="w-fit"
            onClick={onOpenIssues}
            data-testid="project-open-issues"
          >
            {t("projects.openIssues")}
          </Button>
        </section>

        <Separator />

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("projects.description")}
          </h3>
          <IssueTextEditor
            value={project.description ?? ""}
            multiline
            onCommit={(description) => onPatch({ description })}
            placeholder={t("projects.descriptionHint")}
            ariaLabel={t("projects.description")}
            testId="project-description"
            className="-mx-2 leading-relaxed"
          />
        </section>

        <Separator />

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("projects.resources")}
          </h3>
          {project.resources.length === 0 ? (
            <p className="text-xs italic text-muted-foreground">{t("projects.noResources")}</p>
          ) : (
            <ul className="flex flex-col gap-1.5" data-testid="project-resources">
              {project.resources.map((resource, index) => (
                <li
                  key={resource.kind === "github-repo" ? resource.repoFullName : resource.rootId}
                  className="flex items-center gap-2 text-xs"
                >
                  {resource.kind === "github-repo" ? (
                    <>
                      <FolderGitIcon aria-hidden className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate font-mono">
                        {resource.repoFullName}
                      </span>
                    </>
                  ) : (
                    <>
                      <FolderIcon aria-hidden className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{resource.rootId}</span>
                    </>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6 shrink-0"
                    aria-label={t("projects.removeResource")}
                    onClick={() => onRemoveResource(index)}
                    data-testid={`project-resource-remove-${index}`}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Button
            size="sm"
            variant="outline"
            className="w-fit"
            onClick={onAddResource}
            data-testid="project-add-resource"
          >
            <PlusIcon className="size-3.5" />
            {t("projects.addResource")}
          </Button>
          <p className="text-[11px] text-muted-foreground">{t("projects.directoryHint")}</p>
        </section>

        <Separator />

        <Button
          size="sm"
          variant="ghost"
          className="w-fit gap-1.5 text-destructive hover:text-destructive"
          onClick={onRequestDelete}
          data-testid="project-delete"
        >
          <Trash2Icon className="size-3.5" />
          {t("projects.delete")}
        </Button>
      </div>
    </div>
  )
}

/**
 * The container's icon, from a small fixed palette.
 *
 * A free-text emoji field invites a paste of anything — a whole sentence, a
 * ZWJ sequence that renders as tofu on another platform — into a slot that has
 * to stay one glyph wide in a table cell. A short list also makes containers
 * distinguishable at a glance, which is the icon's only job.
 */
const PROJECT_ICONS = [
  "📁",
  "🚀",
  "🐛",
  "🎯",
  "🧪",
  "🛠️",
  "📦",
  "🔒",
  "📈",
  "🎨",
  "⚡",
  "🌱",
] as const

function IconPicker({ value, onChange }: { value?: string; onChange: (icon: string) => void }) {
  const t = useTranslations("issues")
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-7 shrink-0 text-base"
          aria-label={t("projects.icon")}
          data-testid="project-icon"
        >
          <span aria-hidden>{value ?? "📁"}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto">
        <div className="grid grid-cols-6 gap-0.5 p-1">
          {PROJECT_ICONS.map((icon) => (
            <button
              key={icon}
              type="button"
              onClick={() => onChange(icon)}
              aria-label={icon}
              data-testid={`project-icon-${icon}`}
              className="focus-visible:ring-ring/50 grid size-8 place-items-center rounded-md text-base hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px]"
            >
              <span aria-hidden>{icon}</span>
            </button>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-20 shrink-0 pt-1 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

/** A tiny single-select dropdown; the container's own enums are not shared. */
function PickerMenu({
  testId,
  current,
  icon,
  options,
}: {
  testId: string
  current: string
  icon?: React.ReactNode
  options: ReadonlyArray<{
    id: string
    label: string
    icon?: React.ReactNode
    checked: boolean
    onSelect: () => void
  }>
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="-ml-2 h-7 justify-start gap-1.5 px-2 font-normal"
          data-testid={testId}
        >
          {icon}
          {current}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.id}
            onSelect={option.onSelect}
            data-testid={`${testId}-${option.id}`}
          >
            {option.icon}
            <span className="flex-1">{option.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * A date, as a native picker.
 *
 * Stored as epoch ms; the input speaks `YYYY-MM-DD`. Parsing back through
 * `Date.parse` on a bare date string gives UTC midnight, which is stable and
 * comparable — good enough for a target date, and deliberately not a moment.
 */
function DateField({
  value,
  onChange,
  testId,
  ariaLabel,
}: {
  value?: number
  onChange: (next: number | null) => void
  testId: string
  ariaLabel: string
}) {
  const asInput = value ? new Date(value).toISOString().slice(0, 10) : ""
  return (
    <Input
      type="date"
      value={asInput}
      aria-label={ariaLabel}
      onChange={(event) => {
        const next = event.target.value
        onChange(next ? Date.parse(`${next}T00:00:00.000Z`) : null)
      }}
      className="h-7 w-40 px-2"
      data-testid={testId}
    />
  )
}
