"use client"

/**
 * Select for one agent-level override of an app default.
 *
 * The first option always means "inherit" and reports `undefined`, so the
 * agent never stores a value the user did not pick. A stored value that is not
 * among the offered options (a plugin pack can ship any string) stays visible
 * as its own option instead of rendering as a blank trigger, which is what
 * keeps an unchanged agent round-tripping exactly.
 */

import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/** Radix Select cannot carry `undefined`, so "inherit" travels as this sentinel. */
export const INHERIT_VALUE = "__inherit__"

export interface InheritSelectOption<T extends string> {
  value: T
  label: string
}

export interface InheritSelectProps<T extends string> {
  id: string
  label: string
  description?: string
  value: T | undefined
  options: ReadonlyArray<InheritSelectOption<T>>
  onChange: (next: T | undefined) => void
  /** Label of the inherit option. Defaults to the shared "inherit app default". */
  inheritLabel?: string
  disabled?: boolean
}

export function InheritSelect<T extends string>({
  id,
  label,
  description,
  value,
  options,
  onChange,
  inheritLabel,
  disabled,
}: InheritSelectProps<T>) {
  const t = useTranslations("settings.characters.editor.advanced")
  const unknownStored = value !== undefined && !options.some((option) => option.value === value)

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Select
        value={value ?? INHERIT_VALUE}
        disabled={disabled}
        onValueChange={(next) => onChange(next === INHERIT_VALUE ? undefined : (next as T))}
      >
        <SelectTrigger id={id} aria-label={label} data-testid={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT_VALUE}>{inheritLabel ?? t("inherit")}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
          {unknownStored && <SelectItem value={value}>{t("unknownValue", { value })}</SelectItem>}
        </SelectContent>
      </Select>
      {description && <p className="text-[10px] text-muted-foreground">{description}</p>}
    </div>
  )
}

export interface InheritBooleanSelectProps {
  id: string
  label: string
  description?: string
  value: boolean | undefined
  onChange: (next: boolean | undefined) => void
  inheritLabel?: string
  /** Labels of the explicit choices. Default to the shared "On" / "Off". */
  onLabel?: string
  offLabel?: string
}

/**
 * Three-state switch for a boolean override: inherit (`undefined`), on
 * (`true`), off (`false`). A two-state switch cannot tell "off because the app
 * default is off" from "off because this agent says so".
 */
export function InheritBooleanSelect({
  id,
  label,
  description,
  value,
  onChange,
  inheritLabel,
  onLabel,
  offLabel,
}: InheritBooleanSelectProps) {
  const t = useTranslations("settings.characters.editor.advanced")
  return (
    <InheritSelect<"on" | "off">
      id={id}
      label={label}
      description={description}
      inheritLabel={inheritLabel}
      value={value === undefined ? undefined : value ? "on" : "off"}
      options={[
        { value: "on", label: onLabel ?? t("on") },
        { value: "off", label: offLabel ?? t("off") },
      ]}
      onChange={(next) => onChange(next === undefined ? undefined : next === "on")}
    />
  )
}
