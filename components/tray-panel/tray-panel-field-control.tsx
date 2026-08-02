"use client"

/**
 * Renders one `TrayPanelField` — the piece that makes "custom input box"
 * real. Built-in fields carry i18n keys and custom ones carry literal text;
 * `resolveLabel` collapses that difference so this component never has to know
 * which kind it is holding.
 *
 * Deliberately uncontrolled-free: every control is fully controlled by the
 * caller's value map, because the panel re-seeds defaults on every open and an
 * uncontrolled input would keep the previous visit's text.
 */

import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { resolveLabel } from "@/lib/tray-panel/defaults"
import type { TrayPanelField, TrayPanelFieldValue } from "@/lib/tray-panel/types"
import { cn } from "@/lib/utils"

export interface TrayPanelFieldControlProps {
  field: TrayPanelField
  value: TrayPanelFieldValue | undefined
  onChange: (value: TrayPanelFieldValue) => void
  /** Fired by a `submitOnEnter` textarea when Enter is pressed without Shift. */
  onSubmit?: () => void
  /** Marks the row as failing validation (a required field left empty). */
  invalid?: boolean
  autoFocus?: boolean
}

export function TrayPanelFieldControl({
  field,
  value,
  onChange,
  onSubmit,
  invalid = false,
  autoFocus = false,
}: TrayPanelFieldControlProps) {
  // Root translator: built-in field labels are stored as FULL keys
  // (`trayPanel.actions.…`), so a scoped translator would prepend a second
  // segment and every lookup would miss — same trap `lib/tray/sync.ts` documents.
  const t = useTranslations()
  const label = resolveLabel(field, (key) => t(key))
  const controlId = `tray-panel-field-${field.id}`
  const placeholder =
    "placeholderKey" in field && field.placeholderKey
      ? t(field.placeholderKey)
      : "placeholder" in field
        ? field.placeholder
        : undefined

  if (field.kind === "switch") {
    return (
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={controlId} className="text-xs font-medium">
          {label}
        </Label>
        <Switch
          id={controlId}
          checked={value === true}
          onCheckedChange={(next) => onChange(next)}
        />
      </div>
    )
  }

  const control = (() => {
    switch (field.kind) {
      case "textarea":
        return (
          <Textarea
            id={controlId}
            autoFocus={autoFocus}
            value={typeof value === "string" ? value : ""}
            placeholder={placeholder}
            rows={field.rows ?? 3}
            maxLength={field.maxLength}
            aria-invalid={invalid || undefined}
            className={cn("resize-none text-sm", invalid && "border-destructive")}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (!field.submitOnEnter || !onSubmit) return
              // Shift+Enter keeps its newline; IME composition must never be
              // interrupted mid-word, which is the whole reason for the
              // `isComposing` guard the chat composer also uses.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                onSubmit()
              }
            }}
          />
        )
      case "select":
        return (
          <Select value={typeof value === "string" ? value : ""} onValueChange={onChange}>
            <SelectTrigger id={controlId} className="h-8 w-full text-xs" aria-label={label}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {field.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {resolveLabel(option, (key) => t(key))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      case "number":
        return (
          <Input
            id={controlId}
            type="number"
            autoFocus={autoFocus}
            value={typeof value === "number" ? String(value) : ""}
            min={field.min}
            max={field.max}
            step={field.step}
            aria-invalid={invalid || undefined}
            className={cn("h-8 text-xs", invalid && "border-destructive")}
            // An empty box parses to NaN, which `isFieldEmpty` already treats
            // as missing — so a required numeric field blocks submission
            // instead of silently sending 0.
            onChange={(e) => onChange(e.target.valueAsNumber)}
          />
        )
      default:
        return (
          <Input
            id={controlId}
            autoFocus={autoFocus}
            value={typeof value === "string" ? value : ""}
            placeholder={placeholder}
            maxLength={field.maxLength}
            aria-invalid={invalid || undefined}
            className={cn("h-8 text-xs", invalid && "border-destructive")}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (onSubmit && e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault()
                onSubmit()
              }
            }}
          />
        )
    }
  })()

  return (
    <div className="space-y-1.5">
      <Label htmlFor={controlId} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      {control}
    </div>
  )
}
