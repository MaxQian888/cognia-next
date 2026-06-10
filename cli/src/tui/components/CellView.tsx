/**
 * Renders one transcript cell. A thin switch over the cell kinds — the
 * substance (markdown tokenizing, diff formatting, tool summaries, todo parsing)
 * lives in the pure `markdown/*` and `format/*` modules.
 */
import React from "react"
import { Box, Text } from "ink"

import { Markdown } from "./Markdown"
import { formatEditDiff } from "../markdown/diff"
import { isDiffTool, summarizeToolCall } from "../format/tools"
import type {
  AssistantCell,
  Cell,
  BashCell,
  ErrorCell,
  NoticeCell,
  ThinkingCell,
  Todo,
  TodoCell,
  ToolCell,
  UserCell,
} from "../state/types"

// Tool results stay collapsed by default and only render once the user expands
// them (Ctrl+R), so the cap here is generous — enough to read a file/grep/command
// result without flooding the terminal on a multi-thousand-line payload.
function truncate(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + "…" : s
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
  return (
    <Box>
      <Text color="green" bold>
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
  return (
    <Box flexDirection="column">
      <Text color="magenta" dimColor>
        {cell.collapsed ? "▸" : "▾"} thinking
      </Text>
      {!cell.collapsed && (
        <Text color="gray" dimColor>
          {cell.text}
        </Text>
      )}
    </Box>
  )
}

const STATUS_ICON: Record<ToolCell["status"], string> = {
  running: "⏳",
  done: "✓",
  error: "✗",
}

const STATUS_COLOR: Record<ToolCell["status"], string> = {
  running: "yellow",
  done: "green",
  error: "red",
}

function ToolView({ cell }: { cell: ToolCell }) {
  const summary = summarizeToolCall(cell.toolName, cell.input)
  const diff = isDiffTool(cell.toolName) ? formatEditDiff(cell.toolName, cell.input) : []
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={STATUS_COLOR[cell.status]}>{STATUS_ICON[cell.status]} </Text>
        <Text bold>{cell.toolName}</Text>
        {summary ? <Text color="gray"> {summary}</Text> : null}
        {cell.collapsed ? (
          <Text color="gray" dimColor>
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
                color={line.kind === "add" ? "green" : line.kind === "del" ? "red" : "gray"}
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
        <Text color="gray">{truncate(resultText(cell.result))}</Text>
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
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Todos
      </Text>
      {cell.todos.map((todo, i) => (
        <Text
          key={i}
          color={
            todo.status === "completed"
              ? "green"
              : todo.status === "in_progress"
                ? "yellow"
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

function ErrorView({ cell }: { cell: ErrorCell }) {
  return <Text color="red">✗ {cell.message}</Text>
}

function NoticeView({ cell }: { cell: NoticeCell }) {
  return (
    <Text color="gray" dimColor>
      • {cell.message}
    </Text>
  )
}

function BashView({ cell }: { cell: BashCell }) {
  const color = cell.status === "error" ? "red" : cell.status === "running" ? "yellow" : "gray"
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="magenta">! </Text>
        <Text bold>{cell.command}</Text>
        {cell.status === "running" ? <Text color="yellow"> …</Text> : null}
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
