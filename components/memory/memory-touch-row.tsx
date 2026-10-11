"use client"

/**
 * One memory in the compact `/memory` list (phones, Capacitor, narrow windows).
 *
 * The pointer row's resident pin / edit / archive buttons are three 32px
 * targets per row that squeezed the text into a 20-character column on a
 * phone. Here the whole row is the tap target (open the inspector), a long
 * press starts selection, and the per-row actions live in one ⋯ menu at a
 * 44px target. Editing happens in the inspector — a textarea inside a list
 * row on a phone fights the on-screen keyboard for the same half of the screen.
 */

import { memo } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  CopyIcon,
  FolderInputIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { LongPress } from "@/components/interactions/long-press"
import type { Memory } from "@/types/memory/memory"
import { cn } from "@/lib/utils"

export interface MemoryTouchRowProps {
  memory: Memory
  active?: boolean
  selecting: boolean
  selected: boolean
  onOpen: (id: string, options?: { edit?: boolean }) => void
  onToggleSelect: (id: string, selected: boolean) => void
  onStartSelecting: (id: string) => void
  onPinToggle: (id: string, pinned: boolean) => void
  onArchive: (id: string) => void
  onRestore: (id: string) => void
  onMove: (id: string) => void
  onCopy: (text: string) => void
  onDelete: (id: string) => void
}

function MemoryTouchRowImpl({
  memory,
  active,
  selecting,
  selected,
  onOpen,
  onToggleSelect,
  onStartSelecting,
  onPinToggle,
  onArchive,
  onRestore,
  onMove,
  onCopy,
  onDelete,
}: MemoryTouchRowProps) {
  const t = useTranslations("memory.panel")
  const tTypes = useTranslations("memory.types")
  const tGovernance = useTranslations("memory.governance")
  const format = useFormatter()
  const now = useNow()
  const invalidated = memory.status === "invalidated"
  const review = memory.reviewStatus ?? "unreviewed"
  const governance = review === "conflict" || review === "pending_instruction" ? review : undefined
  // The row's accessible name: enough of the text to tell rows apart.
  const name = memory.text.length > 80 ? `${memory.text.slice(0, 80)}…` : memory.text
  const when =
    memory.accessCount > 0
      ? t("accessedRelative", { time: format.relativeTime(new Date(memory.lastAccessedAt), now) })
      : t("createdRelative", { time: format.relativeTime(new Date(memory.createdAt), now) })

  return (
    <div
      className={cn(
        "flex items-stretch border-b border-border/60",
        active && "bg-primary/8",
        selected && "bg-primary/5",
        invalidated && "opacity-75"
      )}
      data-testid="memory-touch-row"
      data-memory-id={memory.id}
      data-state={selected ? "selected" : undefined}
    >
      <LongPress
        onLongPress={() => onStartSelecting(memory.id)}
        className="relative flex min-w-0 flex-1"
      >
        <button
          type="button"
          onClick={() => (selecting ? onToggleSelect(memory.id, !selected) : onOpen(memory.id))}
          aria-label={
            selecting ? t("selectRowNamed", { text: name }) : t("openRow", { text: name })
          }
          aria-pressed={selecting ? selected : undefined}
          className="absolute inset-0 z-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 active:bg-muted/50"
          data-testid="memory-touch-open"
        />
        <span className="pointer-events-none relative z-10 flex w-full min-w-0 items-start gap-3 py-3 pl-4">
          {selecting ? (
            // Drawn, not a control: the row button toggles, and a checkbox
            // (itself a button) inside it would nest buttons.
            <span
              aria-hidden
              className={cn(
                "mt-0.5 grid size-5 shrink-0 place-items-center rounded-sm border",
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-background"
              )}
              data-testid="memory-touch-select"
            >
              {selected ? <CheckIcon className="size-3.5" /> : null}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 space-y-1">
            <span
              className={cn(
                "line-clamp-3 break-words text-sm leading-snug",
                invalidated && "line-through decoration-muted-foreground/50"
              )}
            >
              {memory.text}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
              {memory.pinned ? (
                <PinIcon className="size-3 text-primary/70" aria-label={t("pinnedLabel")} />
              ) : null}
              <span>{tTypes(memory.type)}</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">
                {t("importanceValue", { value: memory.importance })}
              </span>
              <span aria-hidden>·</span>
              <span>{when}</span>
              {governance ? (
                <Badge
                  variant={governance === "conflict" ? "destructive" : "secondary"}
                  className="h-4 px-1 text-[10px] font-normal"
                >
                  {tGovernance(governance)}
                </Badge>
              ) : null}
              {invalidated ? (
                <Badge variant="secondary" className="h-4 px-1 text-[10px] font-normal">
                  {t("invalidated")}
                </Badge>
              ) : null}
            </span>
          </span>
        </span>
      </LongPress>
      {selecting ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="mr-1 mt-1.5 size-11 shrink-0 text-muted-foreground"
              aria-label={t("moreActions")}
              data-testid="memory-touch-more"
            >
              <MoreHorizontalIcon className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {!invalidated ? (
              <>
                <DropdownMenuItem onSelect={() => onPinToggle(memory.id, !memory.pinned)}>
                  {memory.pinned ? (
                    <PinOffIcon className="size-4" />
                  ) : (
                    <PinIcon className="size-4" />
                  )}
                  {memory.pinned ? t("unpin") : t("pin")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onOpen(memory.id, { edit: true })}>
                  <PencilIcon className="size-4" />
                  {t("edit")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onMove(memory.id)}>
                  <FolderInputIcon className="size-4" />
                  {t("move")}
                </DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuItem onSelect={() => onCopy(memory.text)}>
              <CopyIcon className="size-4" />
              {t("copyText")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {invalidated ? (
              <DropdownMenuItem
                onSelect={() => onRestore(memory.id)}
                data-testid="memory-touch-restore"
              >
                <ArchiveRestoreIcon className="size-4" />
                {t("restore")}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onSelect={() => onArchive(memory.id)}
                data-testid="memory-touch-archive"
              >
                <ArchiveIcon className="size-4" />
                {t("archive")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => onDelete(memory.id)}
              data-testid="memory-touch-delete"
            >
              <Trash2Icon className="size-4" />
              {t("deleteForever")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

export const MemoryTouchRow = memo(MemoryTouchRowImpl)
