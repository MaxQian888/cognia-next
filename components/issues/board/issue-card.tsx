"use client"

/**
 * One card on the issue board.
 *
 * A thin render shell — every decision it reflects (can this move? what does
 * its column look like? which labels apply?) is computed in
 * `lib/issues/board-model.ts` and handed down as props. Keep it that way: the
 * board's rules must stay testable without React or dnd-kit.
 *
 * Federated rows (GitHub mirrors, agent tasks) render with a source badge and
 * are NOT draggable — `capabilities.canMove` is the single gate, so a read-only
 * row can never acquire a drag affordance it would then fail to honour.
 */

import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { FolderIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { LabelChip } from "@/components/labels/label-chip"
import { Badge } from "@/components/ui/badge"
import { actorKey } from "@/lib/issues/board-model"
import { cn } from "@/lib/utils"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { IssuePriorityIcon, IssueStatusIcon } from "../issue-glyphs"

export interface IssueCardProps {
  item: UnifiedIssueItem
  /** Resolved label rows for `item.labelIds`; unresolved ids are simply absent. */
  labels?: readonly LabelRow[]
  /** Display name for `item.issueProjectId`, when the caller can resolve it. */
  projectName?: string
  selected?: boolean
  onSelect?: (unifiedId: string) => void
}

export function IssueCard({ item, labels, projectName, selected, onSelect }: IssueCardProps) {
  const t = useTranslations("issues")
  const draggable = item.capabilities.canMove

  const sortable = useSortable({ id: item.unifiedId, disabled: !draggable })
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable

  const assigneeLabel = item.assignee
    ? (item.assignee.label ?? t(`actor.${item.assignee.kind}`))
    : t("actor.unassigned")

  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={() => onSelect?.(item.unifiedId)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect?.(item.unifiedId)
        }
      }}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-testid={`issue-card-${item.unifiedId}`}
      data-dragging={isDragging || undefined}
      className={cn(
        "group flex w-full cursor-pointer flex-col gap-2 rounded-lg border bg-card p-3 text-left shadow-xs transition-shadow",
        "hover:shadow-sm focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-[3px]",
        draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        selected && "ring-ring/60 ring-2",
        isDragging && "opacity-50"
      )}
    >
      <header className="flex items-center gap-2">
        <IssueStatusIcon status={item.status} />
        <span className="font-mono text-xs text-muted-foreground">{item.identifier}</span>
        <span className="flex-1" />
        {item.priority !== "none" ? <IssuePriorityIcon priority={item.priority} /> : null}
        {item.kind !== "local" ? (
          <Badge
            variant="outline"
            className="h-5 px-1.5 text-[10px] font-normal"
            title={t("source.readOnly", { source: t(`source.${item.kind}`) })}
          >
            {t(`source.${item.kind}`)}
          </Badge>
        ) : null}
      </header>

      <h3 className="line-clamp-2 text-sm font-semibold leading-snug">{item.title}</h3>

      {labels && labels.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {labels.map((label) => (
            <LabelChip key={label.id} label={label} className="h-5 text-[10px]" />
          ))}
        </div>
      ) : null}

      <footer className="flex items-center gap-2 text-xs text-muted-foreground">
        {projectName ? (
          <span className="inline-flex min-w-0 items-center gap-1">
            <FolderIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{projectName}</span>
          </span>
        ) : null}
        <span className="flex-1" />
        <span
          className={cn("truncate", !item.assignee && "italic opacity-70")}
          data-testid={`issue-card-assignee-${actorKey(item.assignee) ?? "none"}`}
        >
          {assigneeLabel}
        </span>
      </footer>
    </article>
  )
}
