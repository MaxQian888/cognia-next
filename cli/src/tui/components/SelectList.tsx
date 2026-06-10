/**
 * A controlled keyboard select list: arrow keys move the highlight, Enter
 * selects, Esc cancels. Stateless — the parent owns `index` and reacts to
 * `onMove` / `onSelect` / `onCancel`, so the same primitive backs both
 * reducer-driven overlays and input-local popups.
 */
import React from "react"
import { Box, Text, useInput } from "ink"

export interface SelectItem {
  label: string
  hint?: string
}

export function SelectList({
  title,
  items,
  index,
  onMove,
  onSelect,
  onCancel,
  isActive = true,
}: {
  title?: string
  items: SelectItem[]
  index: number
  onMove: (delta: number) => void
  onSelect: (index: number) => void
  onCancel?: () => void
  isActive?: boolean
}) {
  useInput(
    (input, key) => {
      if (key.upArrow) onMove(-1)
      else if (key.downArrow) onMove(1)
      else if (key.return) onSelect(index)
      else if (key.escape) onCancel?.()
    },
    { isActive }
  )

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {title ? <Text bold>{title}</Text> : null}
      {items.map((item, i) => (
        <Text key={i} color={i === index ? "cyan" : undefined} bold={i === index}>
          {i === index ? "❯ " : "  "}
          {item.label}
          {item.hint ? <Text color="gray"> {item.hint}</Text> : null}
        </Text>
      ))}
    </Box>
  )
}
