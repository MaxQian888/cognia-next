/**
 * The `/menu` command center overlay. A curated, clickable index of the most
 * common actions; picking a row (Enter or a mouse click) runs its slash command.
 *
 * Thin shell over the already-clickable {@link SelectList}: this panel owns its
 * own highlight (no reducer cursor, like {@link SkillPanel} / {@link AgentsPanel})
 * and maps a pick to `onRun(row.command)`. Mouse clicks + wheel come for free
 * from SelectList's {@link usePanelClick} wiring.
 */
import React, { useState } from "react"

import { SelectList } from "../SelectList"
import { moveIndex } from "../select-list-state"
import type { QuickActionRow } from "../../state/types"

export function QuickActionsPanel({
  rows,
  onRun,
  onClose,
  width,
  maxRows,
  isActive = true,
}: {
  rows: QuickActionRow[]
  /** Run the picked row's slash command (the App closes the overlay first). */
  onRun: (command: string) => void
  onClose: () => void
  width?: number | string
  maxRows?: number
  isActive?: boolean
}) {
  const [index, setIndex] = useState(0)
  const items = rows.map((r) => ({ label: r.label, hint: r.hint }))
  return (
    <SelectList
      title="Quick actions"
      items={items}
      index={index}
      width={width}
      maxRows={maxRows}
      isActive={isActive}
      footerHint="↑/↓ navigate · Enter / click run · Esc close"
      onMove={(delta) => setIndex((i) => moveIndex(i, delta, rows.length))}
      onSelect={(i) => {
        const row = rows[i]
        if (row) onRun(row.command)
      }}
      onCancel={onClose}
    />
  )
}
