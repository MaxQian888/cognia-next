/**
 * Renders one transcript cell. A thin switch over the cell kinds — the
 * substance (markdown tokenizing, diff formatting, tool summaries, todo parsing)
 * lives in the pure `markdown/*` and `format/*` modules.
 */
import React from "react"
import { Box, Text } from "ink"

import { Markdown } from "./Markdown"
import { useTheme } from "../theme/context"
import { formatEditDiff } from "../markdown/diff"
import {
  diffStat,
  isDiffTool,
  resultPreview,
  summarizeResult,
  summarizeToolCall,
  toolDisplayName,
  toolKind,
} from "../format/tools"
import type {
  AssistantCell,
  Cell,
  BashCell,
  ErrorCell,
  NoticeCell,
  PlanCell,
  ThinkingCell,
  Todo,
  TodoCell,
  ToolCell,
  UserCell,
} from "../state/types"

// Tool results stay collapsed by default and only render once the user expands
// them (Ctrl+R), so the cap here is generous — enough to read a file/grep/command
// result without flooding the terminal on a multi-thousand-line payload. When the
// payload overflows, the hidden tail is summarized rather than silently dropped.
const RESULT_MAX = 4000

function truncate(s: string, max = RESULT_MAX): { text: string; hiddenLines: number } {
  if (s.length <= max) return { text: s, hiddenLines: 0 }
  const head = s.slice(0, max)
  const hiddenLines = s.slice(max).split("\n").length
  return { text: head + "…", hiddenLines }
}

function resultText(result: unknown): string {
  if (result == null) return ""
  if (typeof result === "string") return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

function UserView({ cell }: { cell: UserCell }) {
  const theme = useTheme()
  return (
    <Box>
      <Text color={theme.userPrompt} bold>
        ›{" "}
      </Text>
      <Text>{cell.text}</Text>
    </Box>
  )
}

function AssistantView({ cell }: { cell: AssistantCell }) {
  return <Markdown raw={cell.raw} />
}

function ThinkingView({ cell }: { cell: ThinkingCell }) {
  // `∴` (therefore) marks reasoning the way Claude Code / OpenCode do; the body
  // is rendered as markdown (reusing {@link Markdown}) so a model's structured
  // reasoning — lists, code, emphasis — reads properly when expanded.
  const theme = useTheme()
  return (
    <Box flexDirection="column">
      <Text color={theme.thinking} dimColor>
        {cell.collapsed ? "▸" : "▾"} ∴ thinking
      </Text>
      {!cell.collapsed && (
        <Box flexDirection="column" paddingLeft={2}>
          <Markdown raw={cell.text} />
        </Box>
      )}
    </Box>
  )
}

const STATUS_ICON: Record<ToolCell["status"], string> = {
  running: "⏳",
  done: "✓",
  error: "✗",
}

/** "[mcp]" / "[plugin]" namespace badge; builtins get nothing. */
function ToolBadge({ toolName }: { toolName: string }) {
  const theme = useTheme()
  const kind = toolKind(toolName)
  if (kind === "builtin") return null
  return (
    <Text color={kind === "mcp" ? theme.toolMcp : theme.toolPlugin} dimColor>
      [{kind}]{" "}
    </Text>
  )
}

function ToolView({ cell }: { cell: ToolCell }) {
  const theme = useTheme()
  const STATUS_COLOR: Record<ToolCell["status"], string> = {
    running: theme.statusRunning,
    done: theme.statusDone,
    error: theme.statusError,
  }
  const summary = summarizeToolCall(cell.toolName, cell.input)
  const diff = isDiffTool(cell.toolName) ? formatEditDiff(cell.toolName, cell.input) : []
  const stat = diffStat(cell.toolName, cell.input)
  // Result magnitude for the collapsed-card hint — only meaningful once a
  // (non-diff) result has landed and the card is still collapsed.
  const size =
    cell.collapsed && diff.length === 0 && cell.result != null
      ? summarizeResult(cell.result)
      : { lines: 0, bytes: 0 }
  // An errored, collapsed tool shows a one-line error preview in the header so
  // the failure is visible without expanding the card.
  const errorPreview =
    cell.collapsed && cell.status === "error" && cell.result != null
      ? resultPreview(cell.result)
      : ""
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={STATUS_COLOR[cell.status]}>{STATUS_ICON[cell.status]} </Text>
        <ToolBadge toolName={cell.toolName} />
        <Text bold>{toolDisplayName(cell.toolName)}</Text>
        {summary ? <Text color={theme.muted}> {summary}</Text> : null}
        {stat.added > 0 ? <Text color={theme.diffAdded}> +{stat.added}</Text> : null}
        {stat.removed > 0 ? <Text color={theme.diffRemoved}> -{stat.removed}</Text> : null}
        {errorPreview ? (
          <Text color={theme.danger} dimColor>
            {" "}
            · {errorPreview}
          </Text>
        ) : size.lines > 0 ? (
          <Text color={theme.muted} dimColor>
            {" "}
            · {size.lines} line{size.lines === 1 ? "" : "s"}
          </Text>
        ) : null}
        {cell.collapsed ? (
          <Text color={theme.muted} dimColor>
            {" "}
            ▸
          </Text>
        ) : null}
      </Box>
      {diff.length > 0 && (
        <Box flexDirection="column">
          {diff.map((line, i) => {
            const gutter =
              line.kind === "meta"
                ? "    "
                : `${(line.oldNo ?? "").toString().padStart(3)} ${(line.newNo ?? "")
                    .toString()
                    .padStart(3)} `
            return (
              <Text
                key={i}
                color={
                  line.kind === "add"
                    ? theme.diffAdded
                    : line.kind === "del"
                      ? theme.diffRemoved
                      : theme.muted
                }
              >
                <Text dimColor>{gutter}</Text>
                {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
                {line.text}
              </Text>
            )
          })}
        </Box>
      )}
      {!cell.collapsed && diff.length === 0 && cell.result != null && (
        <ResultBody result={cell.result} />
      )}
    </Box>
  )
}

function ResultBody({ result }: { result: unknown }) {
  const theme = useTheme()
  const { text, hiddenLines } = truncate(resultText(result))
  return (
    <Box flexDirection="column">
      <Text color={theme.muted}>{text}</Text>
      {hiddenLines > 0 && (
        <Text color={theme.warning} dimColor>
          {`… +${hiddenLines} more line${hiddenLines === 1 ? "" : "s"} hidden`}
        </Text>
      )}
    </Box>
  )
}

const TODO_MARK: Record<Todo["status"], string> = {
  pending: "☐",
  in_progress: "▣",
  completed: "☑",
}

function TodoView({ cell }: { cell: TodoCell }) {
  const theme = useTheme()
  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        Todos
      </Text>
      {cell.todos.map((todo, i) => (
        <Text
          key={i}
          color={
            todo.status === "completed"
              ? theme.statusDone
              : todo.status === "in_progress"
                ? theme.statusRunning
                : undefined
          }
          strikethrough={todo.status === "completed"}
        >
          {TODO_MARK[todo.status]} {todo.content}
        </Text>
      ))}
    </Box>
  )
}

/** A plan-mode proposal, framed and labelled so it reads as a distinct artifact
 * the user is meant to review and approve (vs. an ordinary reply). */
function PlanView({ cell }: { cell: PlanCell }) {
  const theme = useTheme()
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text color={theme.accent} bold>
        📋 Proposed plan
      </Text>
      <Markdown raw={cell.raw} />
    </Box>
  )
}

function ErrorView({ cell }: { cell: ErrorCell }) {
  const theme = useTheme()
  return <Text color={theme.danger}>✗ {cell.message}</Text>
}

function NoticeView({ cell }: { cell: NoticeCell }) {
  const theme = useTheme()
  return (
    <Text color={theme.muted} dimColor>
      • {cell.message}
    </Text>
  )
}

function BashView({ cell }: { cell: BashCell }) {
  const theme = useTheme()
  const color =
    cell.status === "error"
      ? theme.statusError
      : cell.status === "running"
        ? theme.statusRunning
        : theme.muted
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.secondary}>! </Text>
        <Text bold>{cell.command}</Text>
        {cell.status === "running" ? <Text color={theme.statusRunning}> …</Text> : null}
      </Text>
      {cell.output ? (
        <Text color={color} dimColor>
          {cell.output}
        </Text>
      ) : null}
    </Box>
  )
}

export function CellView({ cell }: { cell: Cell }) {
  switch (cell.kind) {
    case "user":
      return <UserView cell={cell} />
    case "assistant":
      return <AssistantView cell={cell} />
    case "thinking":
      return <ThinkingView cell={cell} />
    case "tool":
      return <ToolView cell={cell} />
    case "todo":
      return <TodoView cell={cell} />
    case "plan":
      return <PlanView cell={cell} />
    case "error":
      return <ErrorView cell={cell} />
    case "notice":
      return <NoticeView cell={cell} />
    case "bash":
      return <BashView cell={cell} />
    default:
      return null
  }
}
