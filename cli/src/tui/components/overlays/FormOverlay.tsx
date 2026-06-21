/**
 * Guided argument-form overlay. Thin — all state transitions delegate to the
 * pure machine in `../../state/form.ts`. Drives one field at a time: free-text
 * fields edit inline, `enum` fields cycle with ←/→, `boolean` fields toggle with
 * space. Tab/↑/↓ move between fields, Enter submits, Esc cancels.
 */
import React from "react"
import { Box, Text, useInput } from "ink"

import { formNextField, formPrevField, formSetValue, type FormOverlayState } from "../../state/form"
import { isMouseSequence } from "../../input/mouse"
import { useTheme } from "../../theme/context"

export interface FormOverlayProps {
  form: FormOverlayState
  onUpdate: (form: FormOverlayState) => void
  onSubmit: () => void
  onCancel: () => void
}

export function FormOverlay({ form, onUpdate, onSubmit, onCancel }: FormOverlayProps) {
  const theme = useTheme()
  const field = form.fields[form.activeField]

  useInput((input, key) => {
    if (key.escape) return onCancel()
    if (key.return) return onSubmit()
    if (key.tab || key.downArrow) return onUpdate(formNextField(form))
    if (key.upArrow) return onUpdate(formPrevField(form))
    if (!field) return

    if (field.spec.type === "enum" && field.spec.options && field.spec.options.length > 0) {
      if (key.leftArrow || key.rightArrow) {
        const opts = field.spec.options
        const cur = opts.indexOf(field.value)
        const delta = key.rightArrow ? 1 : -1
        const next = opts[(((cur + delta) % opts.length) + opts.length) % opts.length]
        onUpdate(formSetValue(form, next))
      }
      return
    }
    if (field.spec.type === "boolean") {
      if (input === " " || key.leftArrow || key.rightArrow) {
        onUpdate(formSetValue(form, field.value === "true" ? "false" : "true"))
      }
      return
    }
    if (key.backspace || key.delete) return onUpdate(formSetValue(form, field.value.slice(0, -1)))
    if (input && !key.ctrl && !key.meta && !isMouseSequence(input))
      onUpdate(formSetValue(form, field.value + input))
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.accent}>
        {form.title}
      </Text>
      {form.fields.map((f, i) => {
        const active = i === form.activeField
        const display =
          f.spec.type === "enum"
            ? `‹ ${f.value || "—"} ›`
            : f.spec.type === "boolean"
              ? f.value === "true"
                ? "[x]"
                : "[ ]"
              : f.value || (active ? "▏" : f.spec.placeholder || "")
        return (
          <Text key={f.spec.name} color={active ? theme.accent : undefined}>
            {active ? "❯ " : "  "}
            {f.spec.label}
            {f.spec.required ? "*" : ""}: <Text color={theme.muted}>{display}</Text>
          </Text>
        )
      })}
      {form.error && <Text color={theme.danger}>{form.error}</Text>}
      <Text color={theme.muted} dimColor>
        Tab/↑↓ field · ←→ choose · Enter submit · Esc cancel
      </Text>
    </Box>
  )
}
