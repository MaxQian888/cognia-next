"use client"

/**
 * The delegate bar (ADR-0225 §2): the panel's primary action, pinned to the
 * bottom like a chat composer instead of sitting in the scrolling stack.
 *
 * The action's first text field is the single growing line; every other field
 * (for the built-in delegate action: where it lands, and whether it sends
 * immediately) lives in an inline options menu, rendered by the same
 * `TrayPanelFieldControl` the settings editor previews, so a user-authored
 * primary action with different fields works here too.
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { ArrowUpIcon, ChevronDownIcon } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { resolveLabel } from "@/lib/tray-panel/defaults"
import type { TrayPanelAction, TrayPanelField } from "@/lib/tray-panel/types"
import { cn } from "@/lib/utils"

import { TrayPanelFieldControl } from "./tray-panel-field-control"
import { useTrayPanelRunner } from "./tray-panel-runner"

const MAX_HEIGHT_PX = 100

/** The field the bar edits inline: the first text or textarea field. */
export function inlineFieldOf(action: TrayPanelAction): TrayPanelField | null {
  return action.fields.find((f) => f.kind === "textarea" || f.kind === "text") ?? null
}

export interface TrayPanelDelegateBarProps {
  action: TrayPanelAction
  autoFocus: boolean
  /** Bumped on every reveal, so focus returns to the bar when it should. */
  revealNonce: number
}

export function TrayPanelDelegateBar({
  action,
  autoFocus,
  revealNonce,
}: TrayPanelDelegateBarProps) {
  const t = useTranslations("trayPanel")
  const tRoot = useTranslations()
  const runner = useTrayPanelRunner()
  const inline = inlineFieldOf(action)
  const options = action.fields.filter((f) => f.id !== inline?.id)
  const values = runner.valuesFor(action.id)
  const invalid = runner.invalidFields(action.id)
  const error = runner.errorMessage(action.id)
  const busy = runner.busyId === action.id
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const text = inline ? String(values[inline.id] ?? "") : ""
  const label = resolveLabel(action, (key) => tRoot(key))
  const placeholder =
    inline && "placeholderKey" in inline && inline.placeholderKey
      ? tRoot(inline.placeholderKey)
      : inline && "placeholder" in inline
        ? inline.placeholder
        : undefined

  // Grow with the content up to a few lines, then scroll.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
  }, [text])

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, [autoFocus, revealNonce])

  // A summary of the options on the chip: the selected label of the first
  // select field, so "→ New conversation" says where the task will land.
  const firstSelect = options.find((f) => f.kind === "select")
  const chip =
    firstSelect && firstSelect.kind === "select"
      ? (() => {
          const selected = firstSelect.options.find((o) => o.value === values[firstSelect.id])
          return selected ? resolveLabel(selected, (key) => tRoot(key)) : t("delegate.options")
        })()
      : t("delegate.options")

  const submitOnEnter =
    inline?.kind === "text" || (inline?.kind === "textarea" && inline.submitOnEnter === true)

  return (
    <div className="shrink-0 border-t px-2.5 pb-1.5 pt-2" data-testid="tray-panel-primary">
      <div
        className={cn(
          "flex items-end gap-1.5 rounded-[10px] bg-muted py-1.5 pl-2.5 pr-1.5",
          inline && invalid.has(inline.id) && "ring-1 ring-destructive"
        )}
      >
        {inline ? (
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            aria-label={resolveLabel(inline, (key) => tRoot(key))}
            aria-invalid={invalid.has(inline.id) || undefined}
            placeholder={placeholder}
            maxLength={"maxLength" in inline ? inline.maxLength : undefined}
            onChange={(event) => runner.setFieldValue(action.id, inline.id, event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
              if (!submitOnEnter) return
              event.preventDefault()
              void runner.run(action)
            }}
            className="max-h-[100px] min-h-5 flex-1 resize-none bg-transparent py-0.5 text-[13px] leading-5 outline-none placeholder:text-muted-foreground"
          />
        ) : (
          <span className="flex-1 py-0.5 text-[13px] text-muted-foreground">{label}</span>
        )}
        {options.length > 0 ? (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t("delegate.optionsLabel")}
                className="inline-flex max-w-32 shrink-0 items-center gap-0.5 rounded-md px-1.5 py-1 text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <span className="truncate">→ {chip}</span>
                <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" side="top" className="w-64 space-y-3 p-3">
              {options.map((field) => (
                <TrayPanelFieldControl
                  key={field.id}
                  field={field}
                  value={values[field.id]}
                  invalid={invalid.has(field.id)}
                  onChange={(next) => runner.setFieldValue(action.id, field.id, next)}
                />
              ))}
            </PopoverContent>
          </Popover>
        ) : null}
        <button
          type="button"
          aria-label={label}
          disabled={busy || (inline?.required === true && text.trim() === "")}
          onClick={() => void runner.run(action)}
          className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition-opacity disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {busy ? <Spinner className="size-3.5" /> : <ArrowUpIcon className="size-3.5" />}
        </button>
      </div>
      {error ? <p className="mt-1 px-1 text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
