"use client"

import { memo, useState, type KeyboardEvent, type MouseEvent } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import Link from "next/link"
import { PinIcon, PinOffIcon, PencilIcon, Trash2Icon, CheckIcon, XIcon } from "lucide-react"
import type { Memory } from "@/types/memory/memory"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"

export interface MemoryRowProps {
  memory: Memory
  onPinToggle: (id: string, pinned: boolean) => void
  onSave: (id: string, text: string) => void
  onDelete: (id: string) => void
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
}

/** One memory in the `/memory` panel — display + inline edit + pin + delete. */
function MemoryRowImpl({
  memory,
  onPinToggle,
  onSave,
  onDelete,
  onOpenDetail,
  active,
  selectable,
  selected,
  onSelectToggle,
  onTagClick,
  activeTags,
}: MemoryRowProps) {
  const t = useTranslations("memory.panel")
  const tTypes = useTranslations("memory.types")
  const tGovernance = useTranslations("memory.governance")
  const format = useFormatter()
  const now = useNow()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(memory.text)
  // Brief fade-out before the delete mutation removes the row from the live
  // query — a virtualized list can't host AnimatePresence exits, so the row
  // animates itself and then hands off to `onDelete`.
  const [removing, setRemoving] = useState(false)

  const invalidated = memory.status === "invalidated"
  const clickable = Boolean(onOpenDetail) && !editing

  // Interactive children must not bubble a click up to the row's open-detail
  // handler (checkbox, action buttons, tag chips, source link, textarea).
  const stop = (e: MouseEvent) => e.stopPropagation()

  const handleRowClick = () => {
    if (clickable) onOpenDetail?.(memory.id)
  }
  const handleRowKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!clickable) return
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      onOpenDetail?.(memory.id)
    }
  }

  return (
    <div
      data-testid="memory-row"
      data-memory-id={memory.id}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? handleRowClick : undefined}
      onKeyDown={clickable ? handleRowKeyDown : undefined}
      className={cn(
        "flex items-start gap-2 rounded-lg border border-border/50 bg-card/80 p-3 backdrop-blur-sm",
        "transition-[opacity,transform] duration-150 ease-out",
        clickable && "cursor-pointer transition-colors hover:border-border",
        invalidated && "opacity-60",
        memory.pinned && "border-primary/40",
        active && "border-primary ring-1 ring-primary/50",
        selected && "bg-primary/5",
        removing && "scale-[0.98] opacity-0"
      )}
    >
      {selectable && (
        <Checkbox
          checked={Boolean(selected)}
          onCheckedChange={(v) => onSelectToggle?.(memory.id, v === true)}
          onClick={stop}
          aria-label={t("selectRow")}
          className="mt-0.5"
          data-testid="memory-select"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {editing ? (
          <Textarea
            aria-label={t("editLabel")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={stop}
            rows={2}
            className="text-sm"
          />
        ) : (
          <p className={cn("break-words text-sm", invalidated && "line-through")}>{memory.text}</p>
        )}
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          <Badge variant="secondary" className="text-[10px]">
            {tTypes(memory.type)}
          </Badge>
          <Badge
            variant={memory.reviewStatus === "conflict" ? "destructive" : "outline"}
            className="text-[10px]"
          >
            {memory.reviewStatus === "conflict"
              ? tGovernance("conflict")
              : tGovernance(memory.evidenceState === "supported" ? "supported" : "legacy")}
          </Badge>
          <span data-testid="memory-importance">★ {memory.importance}</span>
          <span>
            {t("accessedRelative", {
              time: format.relativeTime(new Date(memory.lastAccessedAt), now),
            })}
          </span>
          {memory.sourceSessionId && (
            <Link
              href={`/?session=${memory.sourceSessionId}`}
              onClick={stop}
              className="hover:text-primary"
              data-testid="memory-source-link"
            >
              {t("viewSource")}
            </Link>
          )}
          {invalidated && <span className="italic">{t("invalidated")}</span>}
        </div>
        {memory.tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1" data-testid="memory-tags">
            {memory.tags.map((tag) =>
              onTagClick ? (
                <button
                  key={tag}
                  type="button"
                  onClick={(e) => {
                    stop(e)
                    onTagClick(tag)
                  }}
                  aria-pressed={activeTags?.has(tag) ?? false}
                  className={cn(
                    "rounded-full border px-1.5 py-0.5 text-[10px] transition-colors hover:border-primary/60",
                    activeTags?.has(tag)
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/60 text-muted-foreground"
                  )}
                >
                  #{tag}
                </button>
              ) : (
                <span
                  key={tag}
                  className="rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  #{tag}
                </span>
              )
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {editing ? (
          <>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("saveEdit")}
              onClick={(e) => {
                stop(e)
                const trimmed = draft.trim()
                if (trimmed && trimmed !== memory.text) onSave(memory.id, trimmed)
                setEditing(false)
              }}
            >
              <CheckIcon className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("cancelEdit")}
              onClick={(e) => {
                stop(e)
                setDraft(memory.text)
                setEditing(false)
              }}
            >
              <XIcon className="size-4" />
            </Button>
          </>
        ) : (
          <>
            <Button
              size="icon"
              variant="ghost"
              aria-label={memory.pinned ? t("unpin") : t("pin")}
              onClick={(e) => {
                stop(e)
                onPinToggle(memory.id, !memory.pinned)
              }}
            >
              {memory.pinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("edit")}
              onClick={(e) => {
                stop(e)
                setEditing(true)
              }}
            >
              <PencilIcon className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("delete")}
              disabled={removing}
              onClick={(e) => {
                stop(e)
                setRemoving(true)
                window.setTimeout(() => onDelete(memory.id), 160)
              }}
            >
              <Trash2Icon className="size-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

export const MemoryRow = memo(MemoryRowImpl)
