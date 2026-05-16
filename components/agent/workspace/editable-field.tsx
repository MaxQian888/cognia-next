"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { CheckIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

export type EditableFieldVariant = "input" | "textarea"

export interface EditableFieldProps {
  value: string
  onSave: (next: string) => void
  variant?: EditableFieldVariant
  editTooltipKey: string
  placeholderKey?: string
  emptyHintKey?: string
  displayClassName?: string
  editClassName?: string
  rows?: number
  disabled?: boolean
  "data-testid"?: string
}

/**
 * EditableField — translate-aware inline editor.
 *
 * Display mode: a button rendering the current value (or `emptyHintKey` placeholder when empty).
 * Edit mode: Input or Textarea + ✓/✕ ghost icon buttons.
 *
 * Keyboard: Enter commits (input only), Escape cancels. Input variant also commits on blur.
 * Aria labels for the ✓/✕ controls are pulled from `agentTeamsWorkspace.editableField`.
 */
export function EditableField({
  value,
  onSave,
  variant = "input",
  editTooltipKey,
  placeholderKey,
  emptyHintKey,
  displayClassName,
  editClassName,
  rows = 2,
  disabled = false,
  "data-testid": dataTestId,
}: EditableFieldProps) {
  const t = useTranslations("agentTeamsWorkspace.editableField")
  const prefersReducedMotion = useReducedMotion()
  // Track the value that seeded the current draft so that an external
  // update (e.g. another tab renamed the team) re-seeds the draft on
  // the next render without an effect — see the canonical "derived
  // state from props" pattern in the React docs.
  const [editing, setEditing] = React.useState(false)
  const [seedValue, setSeedValue] = React.useState(value)
  const [draft, setDraft] = React.useState(value)
  const commitGuard = React.useRef(false)
  if (!editing && seedValue !== value) {
    setSeedValue(value)
    setDraft(value)
  }

  const commit = React.useCallback(() => {
    if (commitGuard.current) return
    commitGuard.current = true
    const trimmed = draft.trim()
    if (trimmed !== value.trim()) {
      onSave(trimmed)
    }
    setEditing(false)
    // release the guard after React flushes
    queueMicrotask(() => {
      commitGuard.current = false
    })
  }, [draft, value, onSave])

  const cancel = React.useCallback(() => {
    commitGuard.current = true
    setDraft(value)
    setEditing(false)
    queueMicrotask(() => {
      commitGuard.current = false
    })
  }, [value])

  const handleKey = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      cancel()
      return
    }
    if (event.key === "Enter" && variant === "input") {
      event.preventDefault()
      commit()
    }
  }

  const motionProps = prefersReducedMotion
    ? {
        initial: false,
        animate: { opacity: 1 },
        exit: { opacity: 1 },
        transition: { duration: 0 },
      }
    : {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: 0.09, ease: "easeOut" as const },
      }

  const editLabel = t("editAriaLabel")

  return (
    <AnimatePresence mode="wait" initial={false}>
      {editing ? (
        <motion.span
          key="edit"
          className={cn(
            variant === "textarea" ? "flex items-start gap-1" : "flex items-center gap-1",
            editClassName
          )}
          data-testid={dataTestId ? `${dataTestId}-edit` : undefined}
          {...motionProps}
        >
          {variant === "input" ? (
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKey}
              onBlur={commit}
              placeholder={placeholderKey ? t(placeholderKey) : undefined}
              autoFocus
              aria-label={editLabel}
              className="h-8 text-sm"
              disabled={disabled}
            />
          ) : (
            <Textarea
              rows={rows}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKey}
              placeholder={placeholderKey ? t(placeholderKey) : undefined}
              autoFocus
              aria-label={editLabel}
              className="text-xs"
              disabled={disabled}
            />
          )}
          <span className={cn("flex shrink-0 gap-0.5", variant === "textarea" && "pt-0.5")}>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              onMouseDown={(e) => e.preventDefault()}
              onClick={commit}
              aria-label={t("saveAriaLabel")}
              disabled={disabled}
            >
              <CheckIcon className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              onMouseDown={(e) => e.preventDefault()}
              onClick={cancel}
              aria-label={t("cancelAriaLabel")}
              disabled={disabled}
            >
              <XIcon className="size-3.5" />
            </Button>
          </span>
        </motion.span>
      ) : (
        <motion.button
          key="display"
          type="button"
          className={cn(
            "block w-full text-left transition-colors hover:text-primary disabled:cursor-not-allowed disabled:opacity-50",
            displayClassName
          )}
          title={t(editTooltipKey)}
          onClick={() => !disabled && setEditing(true)}
          disabled={disabled}
          data-testid={dataTestId}
          {...motionProps}
        >
          {value || (emptyHintKey ? t(emptyHintKey) : "")}
        </motion.button>
      )}
    </AnimatePresence>
  )
}
