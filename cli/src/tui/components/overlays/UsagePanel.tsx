/**
 * Expandable token/cost usage panel (`/usage`). Read-only — any key closes it.
 */
import React from "react"
import { Box, Text, useInput } from "ink"

import { usagePanelRows } from "../../format/usage"
import type { UsageInfo } from "../../state/types"

export function UsagePanel({
  usage,
  model,
  onClose,
}: {
  usage?: UsageInfo
  model?: string
  onClose: () => void
}) {
  useInput((_input, key) => {
    if (key.escape || key.return) onClose()
  })
  const rows = usagePanelRows(usage, model)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Usage
      </Text>
      {rows.map((row) => (
        <Text key={row.label}>
          <Text color="gray">{row.label.padEnd(12)}</Text>
          {row.value}
        </Text>
      ))}
      <Text color="gray" dimColor>
        esc to close
      </Text>
    </Box>
  )
}
