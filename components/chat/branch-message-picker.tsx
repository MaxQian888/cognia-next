"use client"

// Cherry-pick which messages a direct branch carries.
//
// Branching took the whole prefix or nothing. In a long thread where the useful
// part is three conclusions scattered through forty turns, that drags every dead
// end along and the model weighs them equally.
//
// Deliberately inside the branch dialog rather than a selection mode in the
// message list: the user is already here deciding how to branch, "which parts"
// is the same decision, and it needs no new prop chain through MessageList /
// MessageRenderer — so it works on the mobile action sheet for free.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import type { UIMessage } from "ai"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import { cn } from "@/lib/utils"

/** Longest preview shown per row before elision. */
const PREVIEW_MAX = 90

export function previewOf(message: UIMessage): string {
  const text = extractPlainText(message.parts).replace(/\s+/g, " ").trim()
  if (!text) return ""
  return text.length <= PREVIEW_MAX ? text : `${text.slice(0, PREVIEW_MAX).trimEnd()}…`
}

export function BranchMessagePicker({
  messages,
  selected,
  onChange,
  className,
}: {
  /** The candidate prefix — everything up to and including the cut-off. */
  messages: readonly UIMessage[]
  /** Currently checked ids. */
  selected: ReadonlySet<string>
  onChange: (next: Set<string>) => void
  className?: string
}) {
  const t = useTranslations("chat.branch.pick")

  // Tool-only turns render as an empty row, which reads as a broken checkbox.
  // They are not separately pickable — a message with no text carries nothing a
  // human chose to keep.
  const rows = useMemo(
    () => messages.map((m) => ({ message: m, preview: previewOf(m) })).filter((r) => r.preview),
    [messages]
  )

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.message.id))

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }

  if (rows.length === 0) return null

  return (
    <div className={cn("space-y-1.5", className)} data-testid="branch-message-picker">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{t("label", { count: selected.size })}</Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          onClick={() => onChange(allSelected ? new Set() : new Set(rows.map((r) => r.message.id)))}
        >
          {allSelected ? t("none") : t("all")}
        </Button>
      </div>
      <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border p-1.5">
        {rows.map(({ message, preview }) => (
          <label
            key={message.id}
            className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/60"
          >
            <Checkbox
              className="mt-0.5"
              checked={selected.has(message.id)}
              onCheckedChange={() => toggle(message.id)}
              aria-label={preview}
            />
            <span className="min-w-0 flex-1">
              <span className="text-muted-foreground mr-1.5 font-medium">
                {message.role === "user" ? t("roleUser") : t("roleAssistant")}
              </span>
              <span className="text-foreground/80">{preview}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}
