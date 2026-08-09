/**
 * The `/status` panel — a Claude-Code-style health + context snapshot.
 * Read-only; any key closes it. Pure presenter: every value comes from the
 * {@link StatusReport} the status controller assembled.
 */
import React from "react"
import { Box, Text } from "ink"
import { useModalInput } from "../../input/input-router"

import { contextGauge } from "../../format/status-bar"
import { useTheme } from "../../theme/context"
import { formatTokens } from "../../format/usage"
import type { StatusReport } from "../../state/types"

const ok = (b: boolean): string => (b ? "✓" : "✗")

export function StatusPanel({ report, onClose }: { report: StatusReport; onClose: () => void }) {
  const theme = useTheme()
  useModalInput((_input, key) => {
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
      // No window ⇒ an external agent whose real window nothing resolved. The
      // token count is still a fact, so show it; the gauge and the "/ total"
      // would both be derived from the built-in provider's table, which
      // describes a model this session isn't running.
      value: report.contextWindow
        ? `${contextGauge(report.contextPct ?? 0)}  ${formatTokens(report.contextTokens)} / ${formatTokens(
            report.contextWindow
          )}`
        : `${formatTokens(report.contextTokens)} used · window unknown for this agent`,
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

  // What the external backend can actually call. Stated as counts rather than a
  // ✓/✗ because "supported" is not the useful fact — "how many tools does the
  // CURRENT policy expose to this agent" is.
  if (report.cogniaParity) {
    const parity = report.cogniaParity
    rows.push({
      label: "Cognia tools",
      value: parity.running
        ? `${parity.builtinToolCount} built-in · ${parity.hostToolCount} host · ${parity.userMcpCount} user MCP`
        : parity.attachable
          ? "bridge not started"
          : "unavailable on this agent",
      ...(parity.running ? {} : { color: theme.warning }),
    })
    rows.push({ label: "Context ver", value: parity.contextVersion })
  }

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
