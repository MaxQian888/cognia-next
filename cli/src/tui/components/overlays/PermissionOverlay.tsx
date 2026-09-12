/**
 * Inline tool-approval prompt. Shows the requested tool + a one-line summary and
 * an allow / allow-always / deny select list. The chosen value becomes a
 * `CapturePermissionDecision` handed back to the paused capture via `onResolve`.
 */
import React from "react"
import { Box, Text, type DOMElement } from "ink"

import { DiffView } from "../DiffView"
import { useTheme } from "../../theme/context"
import { summarizeToolCall, isDiffTool } from "../../format/tools"
import { diffFilePath, formatEditDiff } from "../../markdown/diff"
import { langFromPath } from "../../markdown/highlight"
import { listBuiltinTools, type BuiltinToolRiskLevel } from "@/lib/settings/builtin-tools"
import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"
import type { PermissionChoice, PermissionRequestEvent } from "../../state/types"
import { classifyToolCommand, shellCommandOf } from "../../../agent/command-approval"
import type { CommandVerdict } from "@/lib/claude/permissions/command-safety"
import { useCriticalInput, useModalInput } from "../../input/input-router"
import { usePanelClick } from "../../input/use-panel-click"
import { parseMouseEvent } from "../../input/mouse"
import { wrapTerminalSpans, sanitizeTerminalText } from "../../render/terminal-block"
import { clampScroll, maxScroll, positionLabel } from "../document-view"
import { useCliTranslations } from "../../i18n"

export function choiceToDecision(
  choice: PermissionChoice,
  toolName: string,
  deniedMessage = `Denied "${toolName}".`
): CapturePermissionDecision {
  if (choice.value === "deny") {
    return { decision: "deny", message: deniedMessage }
  }
  return { decision: choice.value }
}

/** Strip the MCP namespace (`mcp__<server>__<tool>` → `<tool>`) for display so
 * the prompt reads "Allow bash?" not "Allow mcp__cognia-tools__bash?". */
export function prettyToolName(name: string): string {
  const parts = name.split("__")
  return parts.length >= 3 && parts[0] === "mcp" ? parts.slice(2).join("__") : name
}

const RISK_BY_NAME: Map<string, BuiltinToolRiskLevel> = new Map(
  listBuiltinTools().map((t) => [t.name, t.riskLevel])
)

const RISK_TOKEN = {
  low: "riskLow",
  medium: "riskMedium",
  high: "riskHigh",
} as const satisfies Record<BuiltinToolRiskLevel, string>

/** Verdict of the command classifier, as a risk level. */
const RISK_BY_VERDICT = {
  allow: "low",
  ask: "medium",
  deny: "high",
} as const satisfies Record<CommandVerdict, BuiltinToolRiskLevel>

/**
 * The risk level to badge this request with.
 *
 * A shell call is rated by its command, not by the fact that it is a shell
 * call. `bash` sits in the catalogue at `high` because `bash` can do anything,
 * which is true and useless: it put the same red badge on `ls` and on
 * `rm -rf /`, and a badge that never varies is one the reader stops seeing.
 * Everything else keeps the catalogue's level, and a tool outside the
 * catalogue (a custom MCP server) still has none.
 */
export function riskLevelFor(toolName: string, input?: unknown): BuiltinToolRiskLevel | undefined {
  const classification = input === undefined ? null : classifyToolCommand(toolName, input)
  if (classification) return RISK_BY_VERDICT[classification.verdict]
  return RISK_BY_NAME.get(prettyToolName(toolName))
}

/**
 * Where the selection starts.
 *
 * On Deny for a command the classifier calls catastrophic, so the dangerous
 * answer is never one blind Enter away. Everything else opens on "Allow once",
 * which is the answer the user wants almost every time they are asked.
 */
export function initialChoiceIndex(
  toolName: string,
  input: unknown,
  choices: readonly PermissionChoice[],
  defaultToNo = false
): number {
  if (!defaultToNo && classifyToolCommand(toolName, input)?.verdict !== "deny") return 0
  const deny = choices.findIndex((c) => c.value === "deny")
  return deny >= 0 ? deny : 0
}

/**
 * The one line that says why this is being asked, when the answer is not
 * already obvious from the command itself. Only the classifier can produce it,
 * so a non-shell tool has none.
 */
export function permissionReason(toolName: string, input: unknown): string | undefined {
  const classification = classifyToolCommand(toolName, input)
  if (!classification || classification.verdict === "allow") return undefined
  return classification.reason
}

/**
 * The line under the title: what this call actually does.
 *
 * Ordered by how concrete it is. The agent's own summary of the arguments wins,
 * then its description of the tool, then the path it named. The last branch is
 * the one that matters most: an approval with nothing to show has to SAY it has
 * nothing to show, because a bare "Allow bash?" reads as a UI that lost the
 * command rather than as an agent that never sent one.
 */
export function permissionDetail(
  req: PermissionRequestEvent,
  summary: string,
  fallback = "The agent sent no details with this request."
): string {
  if (summary) return summary
  if (req.description) return req.description
  if (req.blockedPath) return req.blockedPath
  return fallback
}

export function PermissionOverlay({
  req,
  choices: suppliedChoices,
  index,
  onMove,
  onResolve,
  maxRows = 18,
  columns = 80,
}: {
  req: PermissionRequestEvent
  choices: PermissionChoice[]
  index: number
  onMove: (delta: number) => void
  onResolve: (decision: CapturePermissionDecision) => void
  maxRows?: number
  columns?: number
}) {
  const theme = useTheme()
  const choices = permissionChoicesForRequest(req, suppliedChoices)
  const t = useCliTranslations("cliUiApproval")
  const boxRef = React.useRef<DOMElement | null>(null)
  const [reading, setReading] = React.useState({ req, open: false, scroll: 0 })
  if (reading.req !== req) setReading({ req, open: false, scroll: 0 })
  const input = (req.input as Record<string, unknown>) ?? {}
  const summary = summarizeToolCall(req.toolName, input)
  const detail = permissionDetail(req, summary, t("noDetails"))
  const name = prettyToolName(req.displayName ?? req.toolName)
  const risk = riskLevelFor(req.toolName, input)
  const reason = permissionReason(req.toolName, input)
  const bareName = prettyToolName(req.toolName)
  const diff = React.useMemo(
    () =>
      isDiffTool(bareName)
        ? formatEditDiff(bareName, (req.input as Record<string, unknown>) ?? {})
        : [],
    [bareName, req.input]
  )
  const diffLang = diff.length > 0 ? langFromPath(diffFilePath(input) ?? "") : undefined
  const height = Math.max(1, Math.floor(maxRows))
  const width = Math.max(1, Math.floor(columns) - 1)
  const selected = Math.max(0, Math.min(index, choices.length - 1))
  const label = (choice: PermissionChoice) => {
    const standard = DEFAULT_PERMISSION_CHOICES.find((item) => item.value === choice.value)
    return standard?.label === choice.label ? t(choice.value) : choice.label
  }
  const title = t("title", { name })
  const command = shellCommandOf(req.toolName, req.input)
  const body = [
    title,
    req.description,
    req.blockedPath,
    reason,
    command ? `${t("command")}\n${command}` : undefined,
    `${t("parameters")}\n${JSON.stringify(req.input ?? {}, null, 2)}`,
    diff.length
      ? `${t("diff")}\n${diff.map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "} ${line.text}`).join("\n")}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n\n")
  const lines = React.useMemo(
    () => wrapTerminalSpans([{ text: body, style: "plain" }], width),
    [body, width]
  )
  const viewport = Math.max(1, height - (height >= 3 ? 2 : height >= 2 ? 1 : 0))
  const start = clampScroll(reading.scroll, lines.length, viewport)
  const move = (delta: number) =>
    setReading((state) => ({
      ...state,
      scroll: clampScroll(start + delta, lines.length, viewport),
    }))
  const allChoices = height >= choices.length + 3
  const actionRows = allChoices ? choices.length : 1
  const headerRows = height >= 3 ? 1 : 0
  const footerRows = height >= 2 ? 1 : 0
  const bodyRows = Math.max(0, height - actionRows - headerRows - footerRows)
  const showDescription = bodyRows >= 2 && req.description && req.description !== detail
  const showReason = bodyRows >= (showDescription ? 3 : 2) && reason
  const diffRows = Math.max(0, bodyRows - 1 - (showDescription ? 1 : 0) - (showReason ? 1 : 0))
  const resolve = (target: number) => {
    const choice = choices[target]
    if (choice)
      onResolve(choiceToDecision(choice, req.toolName, t("denied", { name: req.toolName })))
  }
  const mouse = usePanelClick({
    boxRef,
    headerRows: 0,
    borderRows: 0,
    hasAboveMore: false,
    visibleCount: actionRows,
    onPick: (offset) => resolve(allChoices ? offset : selected),
    onWheel: (dir) => onMove(dir === "up" ? -1 : 1),
  })
  // The global interrupt route treats permission Escape as deny-and-stop.
  // Reading is a nested surface: return to the unchanged pending decision first.
  useCriticalInput(() => setReading((state) => ({ ...state, open: false })), {
    isActive: reading.open,
    shouldHandle: (_input, key) => key.escape,
  })
  useModalInput((input, key) => {
    if (reading.open) {
      if (key.escape || key.return || input === "q" || input === "v")
        return setReading((state) => ({ ...state, open: false }))
      if (key.upArrow) return move(-1)
      if (key.downArrow) return move(1)
      if (key.pageUp || input === "b") return move(-viewport)
      if (key.pageDown || input === " ") return move(viewport)
      if (input === "g") return move(-start)
      if (input === "G") return move(maxScroll(lines.length, viewport) - start)
      const event = parseMouseEvent(input)
      if (event?.kind === "wheel") move(event.dir === "up" ? -3 : 3)
      return
    }
    if (input === "v") return setReading((state) => ({ ...state, open: true }))
    if (mouse(input)) return
    if (key.upArrow) return onMove(-1)
    if (key.downArrow) return onMove(1)
    if (key.return) return resolve(selected)
    if (key.escape)
      onResolve(
        choiceToDecision(
          { label: "Deny", value: "deny" },
          req.toolName,
          t("denied", { name: req.toolName })
        )
      )
  })
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {reading.open ? (
        <>
          {height >= 3 ? (
            <Box height={1} flexShrink={0}>
              <Text bold wrap="truncate-end">
                {sanitizeTerminalText(t("review", { name }))}
              </Text>
            </Box>
          ) : null}
          <Box flexDirection="column" height={viewport} flexShrink={0}>
            {lines.slice(start, start + viewport).map((line, i) => (
              <Text key={start + i} wrap="truncate-end">
                {line.plain || " "}
              </Text>
            ))}
          </Box>
          {height >= 2 ? (
            <Box height={1} flexShrink={0}>
              <Text color={theme.muted} wrap="truncate-end">
                {t("back")} · {positionLabel(start, viewport, lines.length)} · {t("scroll")}
              </Text>
            </Box>
          ) : null}
        </>
      ) : (
        <>
          {headerRows ? (
            <Box height={1} flexShrink={0}>
              <Text bold color={theme.warning} wrap="truncate-end">
                {sanitizeTerminalText(title)}
                {risk ? <Text color={theme[RISK_TOKEN[risk]]}> [{t(risk)}]</Text> : null}
              </Text>
            </Box>
          ) : null}
          {bodyRows > 0 ? (
            <Box flexDirection="column" height={bodyRows} flexShrink={1} overflow="hidden">
              <Box flexDirection="column" flexShrink={0}>
                <Text color={theme.muted} wrap="truncate-end">
                  {sanitizeTerminalText(detail)}
                </Text>
                {showDescription ? (
                  <Text color={theme.muted} wrap="truncate-end">
                    {sanitizeTerminalText(req.description!)}
                  </Text>
                ) : null}
                {showReason ? (
                  <Text color={risk ? theme[RISK_TOKEN[risk]] : theme.muted} wrap="truncate-end">
                    {sanitizeTerminalText(reason!)}
                  </Text>
                ) : null}
                {diff.length > 0 && diffRows > 0 ? (
                  <DiffView diff={diff} lang={diffLang} maxLines={diffRows} />
                ) : null}
              </Box>
            </Box>
          ) : null}
          <Box ref={boxRef} flexDirection="column" height={actionRows} flexShrink={0}>
            {(allChoices ? choices : choices.slice(selected, selected + 1)).map(
              (choice, offset) => (
                <Text
                  key={choice.value}
                  color={(allChoices ? offset : selected) === selected ? theme.accent : undefined}
                  bold={(allChoices ? offset : selected) === selected}
                  wrap="truncate-end"
                >
                  {(allChoices ? offset : selected) === selected ? "❯ " : "  "}
                  {sanitizeTerminalText(label(choice))}
                </Text>
              )
            )}
          </Box>
          {footerRows ? (
            <Box height={1} flexShrink={0}>
              <Text color={theme.muted} wrap="truncate-end">
                {width < 70 ? t("compactActions") : `${t("inspect")} · ${t("actions")}`}
              </Text>
            </Box>
          ) : null}
        </>
      )}
    </Box>
  )
}

export const DEFAULT_PERMISSION_CHOICES: PermissionChoice[] = [
  { label: "Allow once", value: "allow" },
  { label: "Allow always", value: "allow_always" },
  { label: "Deny", value: "deny" },
]

export function permissionChoicesForRequest(
  request: Pick<PermissionRequestEvent, "suppressAlwaysAllowRule">,
  choices: PermissionChoice[] = DEFAULT_PERMISSION_CHOICES
): PermissionChoice[] {
  return request.suppressAlwaysAllowRule
    ? choices.filter((choice) => choice.value !== "allow_always")
    : choices
}
