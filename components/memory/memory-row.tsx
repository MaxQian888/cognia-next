"use client"

/**
 * One memory in the `/memory` list.
 *
 * Three deliberate changes from the version this replaces:
 *
 *  - **Archive is the primary destructive action.** `manageMemory` has always
 *    supported a soft delete (`invalidate`) that keeps history and can be
 *    restored, but nothing in the UI ever called it — the trash icon hard-
 *    deleted, which made the "archived" filter unreachable by design. Archive
 *    is now the visible action and permanent delete lives in the overflow menu
 *    behind a confirmation.
 *  - **Actions are revealed, not resident.** Three ghost buttons on every row of
 *    a virtualized list is a lot of ink for controls that apply to one row at a
 *    time. They fade in on hover and on keyboard focus.
 *  - **Governance badges only render when they say something.** Painting
 *    "supported" on every healthy row trains the eye to skip the badge that
 *    matters (conflict / awaiting review / archived).
 */

import { memo, useState, type KeyboardEvent, type MouseEvent } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import Link from "next/link"
import {
  ArchiveIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import type { Memory } from "@/types/memory/memory"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"

/** Row height preset. `compact` is what the mobile mirror and workbench use. */
export type MemoryRowDensity = "comfortable" | "compact"

const MAX_VISIBLE_TAGS = 3

export interface MemoryRowProps {
  memory: Memory
  /** Called with the *desired* pinned state, not the current one. */
  onPinToggle: (id: string, pinned: boolean) => void
  onSave: (id: string, text: string) => void
  /**
   * Permanent delete. Callers are expected to confirm first. Omit on surfaces
   * that have no hard-delete path (the mobile mirror can only archive), and the
   * menu item is left out rather than offered and then failing.
   */
  onDelete?: (id: string) => void
  /**
   * Soft delete — drops the memory out of recall but keeps it restorable.
   * Omit on surfaces that cannot archive (the row then offers delete only).
   */
  onArchive?: (id: string) => void
  /** Open the detail sidebar for this memory. Makes the row body clickable. */
  onOpenDetail?: (id: string) => void
  /** Highlight this row as the one currently shown in the detail sidebar. */
  active?: boolean
  /** Render a leading selection checkbox (bulk mode). */
  selectable?: boolean
  selected?: boolean
  onSelectToggle?: (id: string, selected: boolean) => void
  /** Click a tag chip to add it to the active filter. */
  onTagClick?: (tag: string) => void
  /** Tags currently in the active filter — rendered as "on". */
  activeTags?: ReadonlySet<string>
  density?: MemoryRowDensity
}

function MemoryRowImpl({
  memory,
  onPinToggle,
  onSave,
  onDelete,
  onArchive,
  onOpenDetail,
  active,
  selectable,
  selected,
  onSelectToggle,
  onTagClick,
  activeTags,
  density = "comfortable",
}: MemoryRowProps) {
  const t = useTranslations("memory.panel")
  const tTypes = useTranslations("memory.types")
  const tGovernance = useTranslations("memory.governance")
  const format = useFormatter()
  const now = useNow()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(memory.text)

  const invalidated = memory.status === "invalidated"
  const clickable = Boolean(onOpenDetail) && !editing
  const compact = density === "compact"
  const review = memory.reviewStatus ?? "unreviewed"
  // A healthy, reviewed row says nothing here on purpose — see the file header.
  const governance = review === "conflict" || review === "pending_instruction" ? review : undefined

  const stop = (event: MouseEvent | KeyboardEvent) => event.stopPropagation()

  const commit = () => {
    const next = draft.trim()
    if (next && next !== memory.text) onSave(memory.id, next)
    setEditing(false)
  }

  const cancel = () => {
    setDraft(memory.text)
    setEditing(false)
  }

  const visibleTags = memory.tags.slice(0, MAX_VISIBLE_TAGS)
  const hiddenTagCount = memory.tags.length - visibleTags.length

  return (
    <div
      data-testid="memory-row"
      data-memory-id={memory.id}
      data-active={active ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-density={density}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-current={active ? "true" : undefined}
      onClick={clickable ? () => onOpenDetail?.(memory.id) : undefined}
      onKeyDown={
        clickable
          ? (event) => {
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              onOpenDetail?.(memory.id)
            }
          : undefined
      }
      className={cn(
        "group/row relative flex w-full items-start gap-2 border-b border-border/60 px-3",
        compact ? "py-2" : "py-2.5",
        "motion-safe:transition-colors motion-safe:duration-150",
        clickable && "cursor-pointer",
        "hover:bg-accent/40",
        active && "bg-primary/8 hover:bg-primary/10",
        selected && "bg-primary/5",
        invalidated && "opacity-70",
        // The pinned marker is a rail, not a border colour — it survives the
        // active/selected background swaps that a border would fight with.
        memory.pinned &&
          "before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-primary/60"
      )}
    >
      {selectable ? (
        <Checkbox
          checked={selected}
          onCheckedChange={(value) => onSelectToggle?.(memory.id, value === true)}
          onClick={stop}
          aria-label={t("selectRow")}
          className="mt-0.5 shrink-0"
          data-testid="memory-row-select"
        />
      ) : null}

      <div className="min-w-0 flex-1">
        {editing ? (
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onClick={stop}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                cancel()
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                commit()
              }
            }}
            rows={3}
            autoFocus
            aria-label={t("editLabel")}
            className="text-sm"
          />
        ) : (
          <p
            className={cn(
              "text-sm leading-snug",
              compact ? "line-clamp-2" : "line-clamp-3",
              invalidated && "line-through decoration-muted-foreground/50"
            )}
          >
            {memory.text}
          </p>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Badge variant="outline" className="h-5 px-1.5 font-normal">
            {tTypes(memory.type)}
          </Badge>
          {governance ? (
            <Badge
              variant={governance === "conflict" ? "destructive" : "secondary"}
              className="h-5 px-1.5 font-normal"
              data-testid="memory-row-governance"
            >
              {tGovernance(governance)}
            </Badge>
          ) : null}
          {invalidated ? (
            <Badge variant="secondary" className="h-5 px-1.5 font-normal">
              {t("invalidated")}
            </Badge>
          ) : null}
          <span className="tabular-nums">{t("importanceValue", { value: memory.importance })}</span>
          <span aria-hidden="true">·</span>
          <span>
            {t("accessedRelative", {
              time: format.relativeTime(new Date(memory.lastAccessedAt), now),
            })}
          </span>
          {memory.sourceSessionId ? (
            <Link
              href={`/?session=${encodeURIComponent(memory.sourceSessionId)}`}
              onClick={stop}
              className="inline-flex items-center gap-0.5 underline-offset-2 hover:text-foreground hover:underline"
            >
              <ExternalLinkIcon className="size-3" aria-hidden="true" />
              {t("viewSource")}
            </Link>
          ) : null}
        </div>

        {visibleTags.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {visibleTags.map((tag) => (
              <Badge
                key={tag}
                variant={activeTags?.has(tag) ? "default" : "secondary"}
                className={cn("h-5 px-1.5 font-normal", onTagClick && "cursor-pointer")}
                onClick={
                  onTagClick
                    ? (event) => {
                        stop(event)
                        onTagClick(tag)
                      }
                    : undefined
                }
              >
                {tag}
              </Badge>
            ))}
            {hiddenTagCount > 0 ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                {t("moreTags", { count: hiddenTagCount })}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div
        className={cn(
          "flex shrink-0 items-center gap-0.5",
          // Resident while editing (the confirm/cancel pair is the only way
          // out) and while this row is the open one; otherwise revealed.
          !editing &&
            !active &&
            "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 motion-safe:transition-opacity"
        )}
      >
        {editing ? (
          <>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("saveEdit")}
              onClick={(event) => {
                stop(event)
                commit()
              }}
            >
              <CheckIcon className="size-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("cancelEdit")}
              onClick={(event) => {
                stop(event)
                cancel()
              }}
            >
              <XIcon className="size-4" />
            </Button>
          </>
        ) : (
          <>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={memory.pinned ? t("unpin") : t("pin")}
              onClick={(event) => {
                stop(event)
                onPinToggle(memory.id, !memory.pinned)
              }}
            >
              {memory.pinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("edit")}
              onClick={(event) => {
                stop(event)
                setEditing(true)
              }}
            >
              <PencilIcon className="size-4" />
            </Button>
            {onArchive && !invalidated ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("archive")}
                onClick={(event) => {
                  stop(event)
                  onArchive(memory.id)
                }}
                data-testid="memory-row-archive"
              >
                <ArchiveIcon className="size-4" />
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("moreActions")}
                  onClick={stop}
                  data-testid="memory-row-more"
                >
                  <MoreHorizontalIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem
                  onSelect={() => {
                    void navigator.clipboard?.writeText(memory.text)
                  }}
                >
                  <CopyIcon className="size-4" />
                  {t("copyText")}
                </DropdownMenuItem>
                {onDelete ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => onDelete(memory.id)}
                      data-testid="memory-row-delete"
                    >
                      <Trash2Icon className="size-4" />
                      {t("deleteForever")}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </div>
  )
}

export const MemoryRow = memo(MemoryRowImpl)
