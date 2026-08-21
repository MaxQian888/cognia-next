"use client"

/**
 * Inline editor for an issue's title or description.
 *
 * `updateIssue` had no caller anywhere in the app, so once an issue was
 * created neither field could ever be changed. This is the control that fixes
 * that.
 *
 * Commit rules, both chosen because the alternative loses work:
 *  - blur commits, rather than discarding. Clicking away from a field you have
 *    just typed into and finding it reverted is the worst outcome available.
 *  - Escape reverts explicitly, so there IS a way out.
 *  - a title cannot be blanked — an issue with no title is unfindable — so an
 *    empty commit reverts instead.
 */

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

export interface IssueTextEditorProps {
  value: string
  onCommit: (next: string) => void
  multiline?: boolean
  /** Read-only rendering, for federated rows. */
  disabled?: boolean
  placeholder?: string
  className?: string
  ariaLabel: string
  testId: string
  /** Blank is refused and reverts. Titles set this; descriptions do not. */
  required?: boolean
}

export function IssueTextEditor({
  value,
  onCommit,
  multiline,
  disabled,
  placeholder,
  className,
  ariaLabel,
  testId,
  required,
}: IssueTextEditorProps) {
  const t = useTranslations("issues")
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  // Tracks whether Escape already reverted, so the blur that follows does not
  // then commit the reverted draft back over the original.
  const abandoned = useRef(false)

  /**
   * The draft is seeded HERE rather than in an effect that watches `value`.
   *
   * Two reasons: this repo bans `setState` inside an effect, and reading
   * `value` at the moment editing starts is what actually implements the rule
   * — a change from elsewhere (an agent run, an IM card, another device) wins
   * while the field is idle, and never yanks text out from under an edit in
   * progress, because nothing writes the draft while editing except the user.
   */
  function beginEdit() {
    setDraft(value)
    setEditing(true)
  }

  if (disabled || !editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={beginEdit}
        aria-label={ariaLabel}
        data-testid={testId}
        className={cn(
          "focus-visible:ring-ring/50 w-full rounded-md text-left focus-visible:outline-none focus-visible:ring-[3px]",
          !disabled && "hover:bg-accent/40",
          multiline ? "whitespace-pre-wrap px-2 py-1.5" : "px-2 py-1",
          !value && "italic text-muted-foreground",
          className
        )}
      >
        {value || placeholder || t("detail.empty")}
      </button>
    )
  }

  function commit() {
    setEditing(false)
    if (abandoned.current) {
      abandoned.current = false
      setDraft(value)
      return
    }
    const next = multiline ? draft : draft.trim()
    if (required && next.length === 0) {
      setDraft(value)
      return
    }
    if (next !== value) onCommit(next)
  }

  const shared = {
    autoFocus: true,
    value: draft,
    "aria-label": ariaLabel,
    "data-testid": `${testId}-input`,
    onBlur: commit,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        abandoned.current = true
        // Blur runs the revert; doing it here as well would race the state.
        ;(event.target as HTMLElement).blur()
        return
      }
      // Enter commits a single-line field. In a description it is a newline —
      // Cmd/Ctrl+Enter is the commit there.
      if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        ;(event.target as HTMLElement).blur()
      }
    },
  }

  return multiline ? (
    <Textarea
      {...shared}
      rows={4}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      className={cn("min-h-24 text-sm", className)}
    />
  ) : (
    <Input
      {...shared}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      className={cn("h-8", className)}
    />
  )
}
