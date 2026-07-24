/**
 * The `/doctor` diagnostic panel — a grouped, color-coded health report with
 * crash-log inspection. Read-only; keyboard-driven. Reuses the theme palette,
 * the `windowList` viewport helper, and the `DocumentViewer` overlay for report
 * detail.
 */
import React, { useState } from "react"
import { Box, Text, useInput } from "ink"

import { useTheme } from "../../theme/context"
import { windowList } from "../list-window"
import { formatBytes } from "../../runtime/crash-log-discovery"
import type { CrashReportItem, DoctorReport } from "../../state/types"

const STATUS = {
  pass: "✓",
  warn: "⚠",
  fail: "✗",
}

export interface DoctorPanelProps {
  report: DoctorReport
  onClose: () => void
  /** Called when the user chooses to view a crash report. The caller should
   * read the report and open a `DocumentViewer` overlay. */
  onViewReport: (stem: string) => void
  /** Called when the user asks to open the crash-reports dir in the OS file manager. */
  onOpenDir?: () => void
  /** Maximum number of crash-report rows to show at once. */
  maxRows?: number
}

function statusIcon(condition: boolean): { icon: string; color: string } {
  return condition
    ? { icon: STATUS.pass, color: "success" }
    : { icon: STATUS.fail, color: "danger" }
}

function formatCrashReportRow(item: CrashReportItem): string {
  const kind = item.kind ?? "unknown"
  const at = item.capturedAt ? ` · ${item.capturedAt}` : ""
  const size = formatBytes(item.sizeBytes)
  return `${kind}${at} · ${size}`
}

export function DoctorPanel({
  report,
  onClose,
  onViewReport,
  onOpenDir,
  maxRows = 6,
}: DoctorPanelProps) {
  const theme = useTheme()
  const [index, setIndex] = useState(0)
  const reports = report.latestCrash ? [report.latestCrash] : []

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onClose()
      return
    }
    if (input === "o" && onOpenDir) {
      onOpenDir()
      return
    }
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1))
    if (key.downArrow) setIndex((i) => Math.min(reports.length - 1, i + 1))
    if (key.return && reports[index]) {
      onViewReport(reports[index].stem)
    }
  })

  const modelStatus = statusIcon(report.modelValid)
  const storeStatus = statusIcon(report.dbSnapshotExists)
  const backendStatus = statusIcon(report.externalAgentAvailable !== false)
  const hasCrashDir = report.crashReportsDir !== null
  const hasLogsDir = report.logsDir !== null

  const win = windowList(reports.length, index, maxRows)
  const visibleReports = reports.slice(win.start, win.end)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.accent}>
        {`Doctor · cognia-agent v${report.version}`}
      </Text>

      {/* Config */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={theme.muted}>
          Config
        </Text>
        <Text>
          <Text color={theme.muted}>{"Backend".padEnd(13)}</Text>
          {report.agentBackend}
          {report.externalAgentCommand && (
            <Text color={theme[backendStatus.color as keyof typeof theme]}>
              {` · ${report.externalAgentCommand} ${backendStatus.icon}`}
            </Text>
          )}
        </Text>
        {report.externalAgentSandboxReady !== undefined && (
          <Text>
            <Text color={theme.muted}>{"Sandbox".padEnd(13)}</Text>
            {report.externalAgentPlatformSupported === false ? (
              <Text color={theme.danger}>{`unsupported on this platform ${STATUS.fail}`}</Text>
            ) : (
              <Text color={report.externalAgentSandboxReady ? theme.success : theme.danger}>
                {report.externalAgentSandboxReady
                  ? `strict launcher ${STATUS.pass}`
                  : `launcher missing ${STATUS.fail}`}
              </Text>
            )}
          </Text>
        )}
        {(report.externalAgentHooksActive === false ||
          report.externalAgentTerminalActive === false) && (
          <Text>
            <Text color={theme.muted}>{"Capabilities".padEnd(13)}</Text>
            {report.externalAgentHooksActive === false && (
              <Text color={theme.warning}>Hooks inert</Text>
            )}
            {report.externalAgentHooksActive === false &&
              report.externalAgentTerminalActive === false && <Text color={theme.muted}> · </Text>}
            {report.externalAgentTerminalActive === false && (
              <Text color={theme.warning}>ACP terminal unavailable</Text>
            )}
          </Text>
        )}
        <Text>
          <Text color={theme.muted}>{"Provider".padEnd(13)}</Text>
          {report.provider}
        </Text>
        <Text>
          <Text color={theme.muted}>{"Model".padEnd(13)}</Text>
          <Text
            color={theme[modelStatus.color as keyof typeof theme]}
          >{`${report.model} ${modelStatus.icon}`}</Text>
          {!report.modelValid && <Text color={theme.warning}>{" (not in catalog)"}</Text>}
        </Text>
        <Text>
          <Text color={theme.muted}>{"Credential".padEnd(13)}</Text>
          {report.auth}
        </Text>
        <Text>
          <Text color={theme.muted}>{"Credentialed".padEnd(13)}</Text>
          {report.credentialedProviders.length ? report.credentialedProviders.join(", ") : "none"}
        </Text>
      </Box>

      {/* Workspace */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={theme.muted}>
          Workspace
        </Text>
        <Text>
          <Text color={theme.muted}>{"Working dir".padEnd(13)}</Text>
          {report.cwd}
        </Text>
        <Text>
          <Text color={theme.muted}>{"Local store".padEnd(13)}</Text>
          <Text
            color={theme[storeStatus.color as keyof typeof theme]}
          >{`${storeStatus.icon} ${report.dbSnapshotPath}`}</Text>
        </Text>
      </Box>

      {/* Cognia parity — what this backend can actually call. Only external
          backends have anything to say here; the built-in agent IS Cognia. */}
      {report.cogniaParity && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.muted}>
            Cognia parity
          </Text>
          <Text>
            <Text color={theme.muted}>{"Context".padEnd(13)}</Text>
            {report.cogniaParity.contextVersion}
          </Text>
          <Text>
            <Text color={theme.muted}>{"Tool bridge".padEnd(13)}</Text>
            <Text
              color={
                report.cogniaParity.running
                  ? undefined
                  : report.cogniaParity.attachable
                    ? theme.warning
                    : theme.danger
              }
            >
              {report.cogniaParity.running
                ? `running · ${report.cogniaParity.connections} connected`
                : report.cogniaParity.attachable
                  ? "not started"
                  : "unsupported by this agent"}
            </Text>
          </Text>
          <Text>
            <Text color={theme.muted}>{"Cognia tools".padEnd(13)}</Text>
            {`${report.cogniaParity.builtinToolCount} built-in · ${report.cogniaParity.hostToolCount} host`}
          </Text>
          <Text>
            <Text color={theme.muted}>{"User MCP".padEnd(13)}</Text>
            {report.cogniaParity.userMcpCount}
          </Text>
          <Text>
            <Text color={theme.muted}>{"Restarts on".padEnd(13)}</Text>
            <Text color={theme.muted}>{report.cogniaParity.restartRequired.join(", ")}</Text>
          </Text>
        </Box>
      )}

      {/* Crash & Logs */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={theme.muted}>
          Crash & Logs
        </Text>
        <Text>
          <Text color={theme.muted}>{"Reports dir".padEnd(13)}</Text>
          <Text color={hasCrashDir ? undefined : theme.warning}>
            {report.crashReportsDir ?? "unable to resolve"}
          </Text>
        </Text>
        <Text>
          <Text color={theme.muted}>{"Reports".padEnd(13)}</Text>
          {report.crashReportCount}
        </Text>
        {report.latestCrash && (
          <Text>
            <Text color={theme.muted}>{"Latest".padEnd(13)}</Text>
            <Text color={theme.warning}>{formatCrashReportRow(report.latestCrash)}</Text>
          </Text>
        )}
        <Text>
          <Text color={theme.muted}>{"Logs".padEnd(13)}</Text>
          {hasLogsDir ? formatBytes(report.logDirBytes) : "unable to resolve"}
        </Text>

        {reports.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.muted}>Recent crash reports</Text>
            {win.above > 0 && <Text color={theme.muted} dimColor>{`  ↑ ${win.above} more`}</Text>}
            {visibleReports.map((item, i) => {
              const row = win.start + i
              const selected = row === index
              return (
                <Text key={item.stem} color={selected ? theme.accent : undefined} bold={selected}>
                  {selected ? "❯ " : "  "}
                  {item.stem}
                  <Text color={theme.muted}>{` · ${formatCrashReportRow(item)}`}</Text>
                </Text>
              )
            })}
            {win.below > 0 && <Text color={theme.muted} dimColor>{`  ↓ ${win.below} more`}</Text>}
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.muted} dimColor>
          {reports.length > 0
            ? "↑↓ enter view · o open dir · esc/q close"
            : "o open dir · esc/q close"}
        </Text>
      </Box>
    </Box>
  )
}
