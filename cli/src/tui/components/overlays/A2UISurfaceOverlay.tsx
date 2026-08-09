import React from "react"
import { Box, Text } from "ink"
import { useModalInput } from "../../input/input-router"

import { buildA2UIRows, type A2UIRow } from "../../a2ui/surface-model"
import type { TuiA2UISurface } from "../../a2ui/surface"
import { useTheme } from "../../theme/context"
import { windowListWithinRows } from "../list-window"
import { contentRows } from "../../layout/terminal-layout"

export interface TuiA2UIAction {
  action: string
  componentId: string
  data: Record<string, unknown>
}

function optionsFor(row: A2UIRow): unknown[] {
  const source = row.component === "Tabs" ? row.node.tabs : (row.node.options ?? row.node.items)
  if (!Array.isArray(source)) return []
  return source.map((option) => {
    if (!option || typeof option !== "object") return option
    const record = option as Record<string, unknown>
    return record.value ?? record.id ?? record.label ?? record.title
  })
}

function nextControlValue(row: A2UIRow): unknown {
  switch (row.component) {
    case "Checkbox":
    case "Radio":
    case "Toggle":
      return !Boolean(row.value)
    case "Slider": {
      const min = Number(row.node.min ?? 0)
      const max = Number(row.node.max ?? 100)
      const step = Number(row.node.step ?? 1)
      const next = Number(row.value ?? min) + step
      return next > max ? min : next
    }
    case "Select":
    case "RadioGroup":
    case "Tabs":
    case "Accordion": {
      const options = optionsFor(row)
      if (options.length === 0) return row.value
      const index = options.findIndex((option) => Object.is(option, row.value))
      return options[(index + 1 + options.length) % options.length]
    }
    default:
      return row.value
  }
}

export function A2UISurfaceOverlay({
  surface,
  maxRows = 8,
  onSubmit,
  onRaw,
  onClose,
}: {
  surface: TuiA2UISurface
  maxRows?: number
  onSubmit: (action: TuiA2UIAction) => void
  onRaw: (body: string) => void
  onClose: () => void
}) {
  const theme = useTheme()
  const [values, setValues] = React.useState<Record<string, unknown>>({})
  const [index, setIndex] = React.useState(0)
  const [confirming, setConfirming] = React.useState<string | null>(null)
  const rows = React.useMemo(() => buildA2UIRows(surface, values), [surface, values])
  const selected = rows[Math.max(0, Math.min(index, rows.length - 1))]
  const window = windowListWithinRows(rows.length, index, Math.max(1, contentRows(maxRows, 4)))

  useModalInput((input, key) => {
    if (key.escape || input === "q") {
      if (confirming) return setConfirming(null)
      return onClose()
    }
    if (input === "r") return onRaw(JSON.stringify(surface, null, 2))
    if (key.upArrow) return setIndex((value) => Math.max(0, value - 1))
    if (key.downArrow) return setIndex((value) => Math.min(rows.length - 1, value + 1))
    if (!selected || selected.kind !== "control") return
    if (selected.editable) {
      if (key.backspace || key.delete) {
        return setValues((current) => ({
          ...current,
          [selected.id]: String(current[selected.id] ?? selected.value ?? "").slice(0, -1),
        }))
      }
      if (input && !key.ctrl && !key.meta && !key.return) {
        return setValues((current) => ({
          ...current,
          [selected.id]: String(current[selected.id] ?? selected.value ?? "") + input,
        }))
      }
    }
    if (!key.return && input !== " ") return
    if (selected.component === "Button") {
      const action = selected.action ?? selected.id
      if (selected.destructive && confirming !== selected.id) {
        return setConfirming(selected.id)
      }
      setConfirming(null)
      return onSubmit({ action, componentId: selected.id, data: { values } })
    }
    setValues((current) => ({ ...current, [selected.id]: nextControlValue(selected) }))
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent} bold>
        A2UI · {surface.surfaceId}
      </Text>
      {window.above > 0 ? <Text color={theme.muted}>{`↑ ${window.above} more`}</Text> : null}
      {rows.slice(window.start, window.end).map((row, offset) => {
        const rowIndex = window.start + offset
        return (
          <Text
            key={row.id}
            color={
              row.kind === "fallback"
                ? theme.warning
                : rowIndex === index
                  ? theme.accent
                  : undefined
            }
            bold={rowIndex === index && row.kind === "control"}
          >
            {rowIndex === index ? "› " : "  "}
            {row.text}
          </Text>
        )
      })}
      {window.below > 0 ? <Text color={theme.muted}>{`↓ ${window.below} more`}</Text> : null}
      {confirming ? (
        <Text color={theme.danger} bold>
          Confirm destructive action · Enter confirm · Esc cancel
        </Text>
      ) : (
        <Text color={theme.muted} dimColor>
          ↑/↓ focus · type/edit · Enter/Space change or submit · r raw data · q/Esc close
        </Text>
      )}
    </Box>
  )
}
