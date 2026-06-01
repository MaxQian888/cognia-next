"use client"

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import Link from "next/link"
import { PinIcon, PinOffIcon, PencilIcon, Trash2Icon, CheckIcon, XIcon } from "lucide-react"
import type { Memory } from "@/types/memory/memory"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

export interface MemoryRowProps {
  memory: Memory
  onPinToggle: (id: string, pinned: boolean) => void
  onSave: (id: string, text: string) => void
  onDelete: (id: string) => void
}

/** One memory in the `/memory` panel — display + inline edit + pin + delete. */
export function MemoryRow({ memory, onPinToggle, onSave, onDelete }: MemoryRowProps) {
  const t = useTranslations("memory.panel")
  const tTypes = useTranslations("memory.types")
  const format = useFormatter()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(memory.text)

  const invalidated = memory.status === "invalidated"

  return (
    <div
      data-testid="memory-row"
      data-memory-id={memory.id}
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3",
        invalidated && "opacity-60",
        memory.pinned && "border-primary/40"
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {editing ? (
            <Textarea
              aria-label={t("editLabel")}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              className="text-sm"
            />
          ) : (
            <p className={cn("break-words text-sm", invalidated && "line-through")}>
              {memory.text}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
            <Badge variant="secondary" className="text-[10px]">
              {tTypes(memory.type)}
            </Badge>
            <span data-testid="memory-importance">★ {memory.importance}</span>
            <span>
              {t("accessedRelative", {
                time: format.relativeTime(new Date(memory.lastAccessedAt)),
              })}
            </span>
            {memory.sourceSessionId && (
              <Link
                href={`/?session=${memory.sourceSessionId}`}
                className="hover:text-primary"
                data-testid="memory-source-link"
              >
                {t("viewSource")}
              </Link>
            )}
            {invalidated && <span className="italic">{t("invalidated")}</span>}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {editing ? (
            <>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("saveEdit")}
                onClick={() => {
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
                onClick={() => {
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
                onClick={() => onPinToggle(memory.id, !memory.pinned)}
              >
                {memory.pinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("edit")}
                onClick={() => setEditing(true)}
              >
                <PencilIcon className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("delete")}
                onClick={() => onDelete(memory.id)}
              >
                <Trash2Icon className="size-4" />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
