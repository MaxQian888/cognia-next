"use client"

/**
 * Edits a task's tags as chips.
 *
 * Tags were stored, filtered on (`/loop` writes one) and shown in the detail,
 * but no form could set them: the task form neither rendered nor returned
 * them, so a draft that arrived with tags lost them on save and a tag could
 * only ever be removed by deleting the task.
 *
 * Enter or a comma commits the text as a tag; Backspace in an empty field
 * removes the last one; pasting "a, b, c" adds three. Tags are trimmed,
 * stripped of a leading `#` (the search box's tag prefix, which people type
 * out of habit), capped in length, and de-duplicated case-insensitively so
 * "Reports" and "reports" do not become two filters for the same thing.
 */

import { useId, useState } from "react"
import { useTranslations } from "next-intl"
import { XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export const MAX_TAG_LENGTH = 32
export const MAX_TAGS = 20

/** Split typed or pasted text into normalised candidate tags. */
export function parseTagText(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((part) => part.trim().replace(/^#+/, "").trim().slice(0, MAX_TAG_LENGTH))
    .filter((part) => part !== "")
}

/** `existing` plus `candidates`, without case-insensitive duplicates, capped at {@link MAX_TAGS}. */
export function mergeTags(existing: readonly string[], candidates: readonly string[]): string[] {
  const next = [...existing]
  const seen = new Set(existing.map((tag) => tag.toLowerCase()))
  for (const candidate of candidates) {
    if (next.length >= MAX_TAGS) break
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    next.push(candidate)
  }
  return next
}

export interface TaskTagsInputProps {
  value: readonly string[]
  onChange: (tags: string[]) => void
  disabled?: boolean
  className?: string
}

export function TaskTagsInput({ value, onChange, disabled, className }: TaskTagsInputProps) {
  const t = useTranslations("scheduler.tagsInput")
  const inputId = useId()
  const hintId = useId()
  const [draft, setDraft] = useState("")
  const full = value.length >= MAX_TAGS

  const commit = (text: string) => {
    const candidates = parseTagText(text)
    if (candidates.length > 0) onChange(mergeTags(value, candidates))
    setDraft("")
  }

  return (
    <div className={cn("space-y-1.5", className)} data-testid="task-tags-input">
      <label htmlFor={inputId} className="text-sm font-medium">
        {t("label")}
      </label>
      <div
        className={cn(
          "flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border bg-background px-2 py-1.5",
          "focus-within:ring-2 focus-within:ring-primary/20",
          disabled && "opacity-60"
        )}
      >
        {value.map((tag) => (
          <Badge
            key={tag}
            variant="secondary"
            className="h-6 gap-1 rounded-full pe-1 text-xs font-normal"
            data-testid="task-tags-input-chip"
          >
            {tag}
            <button
              type="button"
              onClick={() => onChange(value.filter((candidate) => candidate !== tag))}
              disabled={disabled}
              aria-label={t("remove", { tag })}
              className="rounded-full p-0.5 hover:bg-muted-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="task-tags-input-remove"
            >
              <XIcon className="size-3" aria-hidden="true" />
            </button>
          </Badge>
        ))}
        <Input
          id={inputId}
          value={draft}
          disabled={disabled || full}
          onChange={(event) => {
            const next = event.target.value
            // A comma typed (or pasted) mid-text commits what precedes it.
            if (/[,\n]/.test(next)) commit(next)
            else setDraft(next)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              // Inside a form, Enter would submit it; here it means "add this tag".
              event.preventDefault()
              commit(draft)
            } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
              event.preventDefault()
              onChange(value.slice(0, -1))
            }
          }}
          onBlur={() => {
            if (draft.trim() !== "") commit(draft)
          }}
          placeholder={full ? t("full", { max: MAX_TAGS }) : t("placeholder")}
          aria-describedby={hintId}
          className="h-6 min-w-[8rem] flex-1 border-0 bg-transparent px-1 py-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
          data-testid="task-tags-input-field"
        />
      </div>
      <p id={hintId} className="text-[11px] text-muted-foreground">
        {t("hint")}
      </p>
    </div>
  )
}
