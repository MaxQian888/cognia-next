"use client"

/**
 * Number field for an optional setting — a limit, a threshold, a gate — that
 * writes on blur or Enter, never per keystroke.
 *
 * `ClampedNumberInput` is the sibling for a required value: it clamps, and an
 * emptied field reverts. Here an empty field means something ("no limit",
 * "use the default"), so the caller's `parse` decides what the typed text
 * stores, `undefined` clearing it. `format` is its inverse, for display. A
 * draft that parses to the stored value ("25.0" over 25) writes nothing;
 * Escape abandons the draft.
 *
 * Per-keystroke writes are what this replaces. Each was a settings save, and on
 * a mirrored client (a paired phone, or a browser paired to a cloud host) a
 * queued `app_settings_update` too: typing a daily budget of "25" set the
 * desktop's budget to 2 and then to 25.
 */

import type { ComponentProps } from "react"

import { Input } from "@/components/ui/input"
import { useSettingDraft } from "@/hooks/settings/use-setting-draft"

export interface OptionalNumberInputProps extends Omit<
  ComponentProps<typeof Input>,
  "value" | "defaultValue" | "onChange" | "type"
> {
  /** Stored value; `undefined` renders an empty field. */
  value: number | undefined
  /** Typed text → value to store. `undefined` clears the setting. */
  parse: (raw: string) => number | undefined
  /** Stored value → field text. Defaults to `String(value)`, or "" when unset. */
  format?: (value: number | undefined) => string
  /** Called once per commit with the parsed value, when it differs. */
  onCommit: (next: number | undefined) => unknown
}

const formatPlain = (value: number | undefined): string =>
  value === undefined ? "" : String(value)

export function OptionalNumberInput({
  value,
  parse,
  format = formatPlain,
  onCommit,
  onBlur,
  onKeyDown,
  ...rest
}: OptionalNumberInputProps) {
  const draft = useSettingDraft(format(value), (raw) => onCommit(parse(raw)), {
    equals: (a, b) => Object.is(parse(a), parse(b)),
  })

  return (
    <Input
      {...rest}
      type="number"
      value={draft.value}
      onChange={(e) => draft.set(e.target.value)}
      onBlur={(e) => {
        draft.commit()
        onBlur?.(e)
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") draft.discard()
        else draft.commitOnEnter(e)
        onKeyDown?.(e)
      }}
    />
  )
}
