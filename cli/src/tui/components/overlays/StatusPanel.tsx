/**
 * The `/status` panel — a Claude-Code-style health + context snapshot.
 * Read-only; any key closes it. Pure presenter: every value comes from the
 * {@link StatusReport} the status controller assembled.
 */
import React from "react"
import { Box, Text, useInput } from "ink"

import { contextGauge } from "../../format/status-bar"
import { useTheme } from "../../theme/context"
import { formatTokens } from "../../format/usage"
import type { StatusReport } from "../../state/types"

const ok = (b: boolean): string => (b ? "✓" : "✗")

export function StatusPanel({ report, onClose }: { report: StatusReport; onClose: () => void }) {
  const theme = useTheme()
  useInput((_input, key) => {
    if (key.escape || key.return) onClose()
  })

  const rows: { label: string; value: string; color?: string }[] = [
    { label: "Provider", value: report.provider },
    {
      label: "Model",
      value: `${report.model} ${ok(report.modelValid)}`,
      color: report.modelValid ? undefined : theme.warning,
    },
    { label: "Credential", value: report.auth },
    {
      label: "Credentialed",
      value: report.credentialedProviders.length ? report.credentialedProviders.join(", ") : "none",
    },
    {
      label: "Context",
      value: `${contextGauge(report.contextPct)}  ${formatTokens(report.contextTokens)} / ${formatTokens(
        report.contextWindow
      )}`,
    },
    { label: "Working dir", value: report.cwd },
    {
      label: "Git",
      value: report.gitBranch ?? "—",
      color: report.gitBranch ? theme.success : undefined,
    },
    {
      label: "Local store",
      value: `${ok(report.dbSnapshotExists)}`,
      color: report.dbSnapshotExists ? undefined : theme.warning,
    },
  ]

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.accent}>
        {`Status · cognia-agent v${report.version}`}
      </Text>
      {rows.map((row) => (
        <Text key={row.label}>
          <Text color={theme.muted}>{row.label.padEnd(13)}</Text>
          <Text color={row.color}>{row.value}</Text>
        </Text>
      ))}
      <Text color={theme.muted} dimColor>
        esc to close
      </Text>
    </Box>
  )
}
