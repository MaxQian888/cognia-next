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
 *    time. They fade in on hover, on keyboard focus and while the overflow menu
 *    is open, and stay visible on touch (`lib/ui/hover-reveal.ts`).
 *  - **Governance badges only render when they say something.** Painting
 *    "supported" on every healthy row trains the eye to skip the badge that
 *    matters (conflict / awaiting review / archived).
 */

import { memo, useState, type KeyboardEvent, type MouseEvent } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import Link from "next/link"
import { buildSessionHref } from "@/lib/chat/message-permalink"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  FolderInputIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import type { Memory } from "@/types/memory/memory"
import { cn } from "@/lib/utils"
import { HOVER_REVEAL_GROUP_BASE_CLASS } from "@/lib/ui/hover-reveal"
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

/** Row height preset. `compact` is what the context workbench uses. */
export type MemoryRowDensity = "comfortable" | "compact"

const MAX_VISIBLE_TAGS = 3

export interface MemoryRowProps {
  memory: Memory
  /** Called with the *desired* pinned state, not the current one. */
  onPinToggle: (id: string, pinned: boolean) => void
  onSave: (id: string, text: string) => void
  /**
   * Request a permanent delete. The console confirms before anything runs
   * (`useMemoryConsole().requestDelete`). Omit on surfaces with no delete path
   * and the menu item is left out rather than offered and then failing.
   */
  onDelete?: (id: string) => void
  /**
   * Soft delete — drops the memory out of recall but keeps it restorable.
   * Omit on surfaces that cannot archive (the row then offers delete only).
   */
  onArchive?: (id: string) => void
  /** Bring an archived memory back. Shown in place of Archive on archived rows. */
  onRestore?: (id: string) => void
  /** Move to another namespace (opens the move dialog). */
  onMove?: (id: string) => void
  /** Copy the text; the caller confirms it. Falls back to a silent clipboard write. */
  onCopy?: (text: string) => void
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
  onRestore,
  onMove,
  onCopy,
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
        invalidated && "opacity-70"
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
              "break-words text-sm leading-snug",
              compact ? "line-clamp-2" : "line-clamp-3",
              invalidated && "line-through decoration-muted-foreground/50"
            )}
          >
            {memory.text}
          </p>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {memory.pinned ? (
            <PinIcon
              className="size-3 shrink-0 text-primary/70"
              aria-label={t("pinnedLabel")}
              data-testid="memory-row-pinned"
            />
          ) : null}
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
            {/* `lastAccessedAt` starts at creation, so an unused memory read
                "used now" the moment it was added. Say when it was added
                until something has actually recalled it. */}
            {memory.accessCount > 0
              ? t("accessedRelative", {
                  time: format.relativeTime(new Date(memory.lastAccessedAt), now),
                })
              : t("createdRelative", {
                  time: format.relativeTime(new Date(memory.createdAt), now),
                })}
          </span>
          {memory.sourceSessionId ? (
            <Link
              // `sourceMessageId` has been indexed since v122 and is written by
              // the consolidator — but both link sites built the session-only
              // href by hand, so "jump to source" landed on the conversation
              // rather than on the turn that taught this.
              href={buildSessionHref(memory.sourceSessionId, memory.sourceMessageId)}
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
                className={cn(
                  "min-h-5 max-w-full whitespace-normal break-all px-1.5 py-px font-normal",
                  onTagClick && "cursor-pointer"
                )}
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
        data-testid="memory-row-actions"
        className={cn(
          "flex shrink-0 items-center gap-0.5",
          // Resident while editing (the confirm/cancel pair is the only way
          // out) and while this row is the open one; otherwise revealed on
          // row hover, on focus anywhere in the row, while the overflow menu
          // is open, and always on touch (the shared reveal policy). Only the
          // opacity fades, so every action stays focusable and clickable.
          !editing &&
            !active &&
            cn(
              HOVER_REVEAL_GROUP_BASE_CLASS,
              "group-hover/row:opacity-100 group-focus-within/row:opacity-100 motion-reduce:transition-none"
            )
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
            {onRestore && invalidated ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("restore")}
                onClick={(event) => {
                  stop(event)
                  onRestore(memory.id)
                }}
                data-testid="memory-row-restore"
              >
                <ArchiveRestoreIcon className="size-4" />
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("moreActions")}
                  onClick={stop}
                  onKeyDown={stop}
                  data-testid="memory-row-more"
                >
                  <MoreHorizontalIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  onSelect={() => {
                    if (onCopy) onCopy(memory.text)
                    else void navigator.clipboard?.writeText(memory.text)
                  }}
                >
                  <CopyIcon className="size-4" />
                  {t("copyText")}
                </DropdownMenuItem>
                {onMove && !invalidated ? (
                  <DropdownMenuItem
                    onSelect={() => onMove(memory.id)}
                    data-testid="memory-row-move"
                  >
                    <FolderInputIcon className="size-4" />
                    {t("move")}
                  </DropdownMenuItem>
                ) : null}
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
