"use client"

/**
 * Editor for an action's custom input fields — the "支持自定义输入框" half of
 * the tray quick panel.
 *
 * Each row is one `TrayPanelField`. The id is shown prominently because it is
 * how the effect references the value (`{{id}}`), which is the single thing a
 * user has to understand to wire an input to an action.
 *
 * Flat by construction: no card wrappers, hairline separation only, matching
 * `components/settings/common/settings-block.tsx`.
 */

import { useTranslations } from "next-intl"
import { PlusIcon, TrashIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
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
import type { TrayPanelField, TrayPanelFieldKind } from "@/lib/tray-panel/types"

const FIELD_KINDS: TrayPanelFieldKind[] = ["text", "textarea", "select", "switch", "number"]

/** A blank field of `kind`, with an id that won't collide with `existing`. */
export function blankField(kind: TrayPanelFieldKind, existing: readonly string[]): TrayPanelField {
  let n = existing.length + 1
  while (existing.includes(`field${n}`)) n += 1
  const id = `field${n}`
  const base = { id, label: id }
  switch (kind) {
    case "select":
      return { ...base, kind, options: [{ value: "a", label: "A" }] }
    case "switch":
      return { ...base, kind, defaultValue: false }
    case "number":
      return { ...base, kind }
    case "textarea":
      return { ...base, kind, rows: 3 }
    default:
      return { ...base, kind: "text" }
  }
}

/** Parse the `value=Label` lines the select-options textarea accepts. */
export function parseOptionLines(raw: string): { value: string; label: string }[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const eq = line.indexOf("=")
      // A bare line is both value and label — the common case for a short list.
      if (eq < 0) return { value: line, label: line }
      return { value: line.slice(0, eq).trim(), label: line.slice(eq + 1).trim() }
    })
    .filter((option) => option.value.length > 0)
}

/** Render option rows back into the textarea's `value=Label` form. */
export function formatOptionLines(options: readonly { value: string; label: string }[]): string {
  return options.map((o) => (o.value === o.label ? o.value : `${o.value}=${o.label}`)).join("\n")
}

export interface TrayPanelFieldEditorProps {
  fields: TrayPanelField[]
  onChange: (fields: TrayPanelField[]) => void
  /** Ids flagged by validation, rendered with a destructive border. */
  invalidIds?: ReadonlySet<string>
}

export function TrayPanelFieldEditor({ fields, onChange, invalidIds }: TrayPanelFieldEditorProps) {
  const t = useTranslations("settings.trayPanel.fieldEditor")

  const patch = (index: number, next: Partial<TrayPanelField>) => {
    const copy = fields.slice()
    copy[index] = { ...copy[index], ...next } as TrayPanelField
    onChange(copy)
  }

  const changeKind = (index: number, kind: TrayPanelFieldKind) => {
    const current = fields[index]
    // Rebuild from a blank of the new kind so no stale kind-specific member
    // (a `rows` on a switch, an `options` on a number) survives the change.
    const replacement = blankField(
      kind,
      fields.filter((_, i) => i !== index).map((f) => f.id)
    )
    const copy = fields.slice()
    copy[index] = {
      ...replacement,
      id: current.id,
      label: current.label,
      required: current.required,
    }
    onChange(copy)
  }

  return (
    <div className="space-y-3">
      {fields.length === 0 ? <p className="text-xs text-muted-foreground">{t("empty")}</p> : null}

      {fields.map((field, index) => (
        <div
          key={`${field.id}-${index}`}
          data-testid={`tray-panel-field-row-${index}`}
          className="space-y-2 border-b border-border/50 pb-3 last:border-b-0 last:pb-0"
        >
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <Label htmlFor={`field-id-${index}`} className="text-xs text-muted-foreground">
                {t("id")}
              </Label>
              <Input
                id={`field-id-${index}`}
                value={field.id}
                aria-invalid={invalidIds?.has(field.id) || undefined}
                className="h-8 font-mono text-xs"
                onChange={(e) => patch(index, { id: e.target.value })}
              />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <Label htmlFor={`field-label-${index}`} className="text-xs text-muted-foreground">
                {t("label")}
              </Label>
              <Input
                id={`field-label-${index}`}
                value={field.label}
                className="h-8 text-xs"
                // A built-in's label is an i18n key; editing it makes the entry
                // user-owned, so drop the key or the edit would never show.
                onChange={(e) => patch(index, { label: e.target.value, labelKey: undefined })}
              />
            </div>
            <div className="w-28 space-y-1">
              <Label className="text-xs text-muted-foreground">{t("kind")}</Label>
              <Select
                value={field.kind}
                onValueChange={(v) => changeKind(index, v as TrayPanelFieldKind)}
              >
                <SelectTrigger className="h-8 text-xs" aria-label={t("kind")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(`kinds.${kind}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              aria-label={t("remove")}
              onClick={() => onChange(fields.filter((_, i) => i !== index))}
            >
              <TrashIcon className="size-3.5" />
            </Button>
          </div>

          {field.kind === "select" ? (
            <div className="space-y-1">
              <Label htmlFor={`field-options-${index}`} className="text-xs text-muted-foreground">
                {t("options")}
              </Label>
              <textarea
                id={`field-options-${index}`}
                rows={3}
                value={formatOptionLines(field.options)}
                placeholder={t("optionsPlaceholder")}
                className="w-full rounded-md border bg-transparent px-2 py-1.5 font-mono text-xs"
                onChange={(e) => patch(index, { options: parseOptionLines(e.target.value) })}
              />
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch
                id={`field-required-${index}`}
                checked={field.required ?? false}
                onCheckedChange={(on) => patch(index, { required: on })}
              />
              <Label htmlFor={`field-required-${index}`} className="text-xs">
                {t("required")}
              </Label>
            </div>
            {field.kind === "textarea" ? (
              <div className="flex items-center gap-2">
                <Switch
                  id={`field-submit-${index}`}
                  checked={field.submitOnEnter ?? false}
                  onCheckedChange={(on) => patch(index, { submitOnEnter: on })}
                />
                <Label htmlFor={`field-submit-${index}`} className="text-xs">
                  {t("submitOnEnter")}
                </Label>
              </div>
            ) : null}
          </div>
        </div>
      ))}

      <Button
        size="sm"
        variant="outline"
        className="h-8"
        onClick={() =>
          onChange([
            ...fields,
            blankField(
              "text",
              fields.map((f) => f.id)
            ),
          ])
        }
      >
        <PlusIcon className="mr-1.5 size-3.5" />
        {t("add")}
      </Button>
    </div>
  )
}
