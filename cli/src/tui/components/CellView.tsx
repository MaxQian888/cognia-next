/**
 * Renders one transcript cell. A thin switch over the cell kinds — the
 * substance (markdown tokenizing, diff formatting, tool summaries, todo parsing)
 * lives in the pure `markdown/*` and `format/*` modules.
 */
import React from "react"
import { Box, Text } from "ink"

import { Markdown } from "./Markdown"
import { useTheme } from "../theme/context"
import { useRenderPrefs } from "../render/context"
import { diffFilePath, formatEditDiff, highlightDiffText } from "../markdown/diff"
import { langFromPath } from "../markdown/highlight"
import { renderResultLines, resultToText, toolResultLang } from "../format/result-render"
import {
  extractResultImages,
  elideImageData,
  formatBytes,
  type ExtractedImage,
} from "../format/result-images"
import { buildImageEscape, detectGraphics } from "../format/terminal-graphics"
import {
  diffStat,
  isDiffTool,
  resultPreview,
  summarizeResult,
  summarizeToolCall,
  toolDisplayName,
  toolKind,
} from "../format/tools"
import { isSubagentTool, subagentName, subagentTask } from "../format/subagent"
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
  const diffLang = diff.length > 0 ? langFromPath(diffFilePath(cell.input) ?? "") : undefined
  const diffColors = { add: theme.diffAdded, del: theme.diffRemoved, context: theme.muted }
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
        {cell.collapsed && cell.result != null ? (
          <Text color={theme.accent} dimColor>
            {" "}
            ▸ expand: /inspect
          </Text>
        ) : cell.collapsed ? (
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
              <Text key={i}>
                <Text dimColor>{gutter}</Text>
                {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
                {highlightDiffText(line, diffLang, diffColors)}
              </Text>
            )
          })}
        </Box>
      )}
      {!cell.collapsed && diff.length === 0 && cell.result != null && (
        <ToolResult result={cell.result} lang={toolResultLang(cell.toolName, cell.input)} />
      )}
    </Box>
  )
}

/**
 * Expanded tool result = any inline images (rendered as graphics) plus the
 * textual body with image base64 elided, so an image result no longer floods
 * the transcript with a base64 wall.
 */
function ToolResult({ result, lang }: { result: unknown; lang?: string }) {
  const images = extractResultImages(result)
  if (images.length === 0) return <ResultBody result={result} lang={lang} />
  return (
    <Box flexDirection="column">
      <ToolImages images={images} />
      <ResultBody result={elideImageData(result)} lang={lang} />
    </Box>
  )
}

/**
 * Renders the image blocks pulled out of a tool result. On a graphics-capable
 * terminal (iTerm2 / kitty / WezTerm) each image is emitted as an inline escape
 * sequence — the transcript is written once (`<Static>`), so the bytes reach the
 * terminal verbatim. Elsewhere it degrades to a one-line placeholder so the user
 * at least knows an image came back (instead of a base64 wall).
 */
function ToolImages({ images }: { images: ExtractedImage[] }) {
  const theme = useTheme()
  const protocol = detectGraphics(process.env)
  return (
    <Box flexDirection="column">
      {images.map((img, i) => {
        const seq =
          protocol === "none"
            ? null
            : buildImageEscape(protocol, Buffer.from(img.data, "base64"), `image-${i}`)
        if (seq) return <Text key={i}>{seq}</Text>
        return (
          <Text key={i} color={theme.muted} dimColor>
            🖼 image ({img.mediaType}, {formatBytes(img.bytes)}) — inline display needs
            iTerm2/kitty/WezTerm
          </Text>
        )
      })}
    </Box>
  )
}

/**
 * Renders an expanded tool/file result: syntax-highlighted (per render prefs +
 * the detected `lang`), optionally line-numbered, line-capped. A very large
 * result (over `pagerThresholdLines`) collapses to a short preview plus a
 * "open in pager" hint instead of flooding the transcript.
 */
function ResultBody({ result, lang }: { result: unknown; lang?: string }) {
  const theme = useTheme()
  const prefs = useRenderPrefs()
  const text = resultToText(result)
  if (!text) return null

  const totalLines = text.split("\n").length
  const colored = prefs.syntaxHighlightInline && Boolean(lang)
  const tooBig = totalLines > prefs.pagerThresholdLines
  const maxLines = tooBig ? Math.min(prefs.toolResultMaxLines, 20) : prefs.toolResultMaxLines

  const rendered = renderResultLines(text, {
    lang,
    highlight: prefs.syntaxHighlightInline,
    lineNumbers: prefs.fileLineNumbers,
    palette: theme,
    maxLines,
  })

  return (
    <Box flexDirection="column">
      {rendered.lines.map((line, i) =>
        colored ? (
          <Text key={i}>{line}</Text>
        ) : (
          <Text key={i} color={theme.muted}>
            {line}
          </Text>
        )
      )}
      {tooBig ? (
        <Text color={theme.warning} dimColor>
          {`… ${totalLines} lines total — open full output: /expand`}
        </Text>
      ) : rendered.hiddenLines > 0 ? (
        <Text color={theme.warning} dimColor>
          {`… +${rendered.hiddenLines} more line${rendered.hiddenLines === 1 ? "" : "s"} hidden — /expand`}
        </Text>
      ) : null}
    </Box>
  )
}

const SUBAGENT_STATUS_LABEL: Record<ToolCell["status"], string> = {
  running: "running",
  done: "done",
  error: "failed",
}

/**
 * A sub-agent dispatch (`task` / `dispatch_agent` / `agent`) rendered as a
 * first-class, inline-indented unit — a `◆` marker, the agent's name, the task
 * it was handed, a status badge, and (when expanded) its reply. The data all
 * rides the normal {@link ToolCell} pipeline; this view just frames it like a
 * delegated agent instead of an opaque tool card.
 */
function SubagentView({ cell }: { cell: ToolCell }) {
  const theme = useTheme()
  const STATUS_COLOR: Record<ToolCell["status"], string> = {
    running: theme.statusRunning,
    done: theme.statusDone,
    error: theme.statusError,
  }
  const name = subagentName(cell.input)
  const task = subagentTask(cell.input)
  const size =
    cell.collapsed && cell.result != null ? summarizeResult(cell.result) : { lines: 0, bytes: 0 }
  const errorPreview =
    cell.collapsed && cell.status === "error" && cell.result != null
      ? resultPreview(cell.result)
      : ""
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={STATUS_COLOR[cell.status]}>{STATUS_ICON[cell.status]} </Text>
        <Text color={theme.accent} bold>
          ◆ {name}
        </Text>
        <Text color={theme.muted} dimColor>
          {" "}
          subagent · {SUBAGENT_STATUS_LABEL[cell.status]}
        </Text>
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
        {cell.collapsed && cell.result != null ? (
          <Text color={theme.accent} dimColor>
            {" "}
            ▸ expand: /inspect
          </Text>
        ) : cell.collapsed ? (
          <Text color={theme.muted} dimColor>
            {" "}
            ▸
          </Text>
        ) : null}
      </Box>
      {task ? (
        <Box paddingLeft={2}>
          <Text color={theme.muted}>{task}</Text>
        </Box>
      ) : null}
      {!cell.collapsed && cell.result != null && (
        <Box paddingLeft={2}>
          <ToolResult result={cell.result} />
        </Box>
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
      return isSubagentTool(cell.toolName) ? <SubagentView cell={cell} /> : <ToolView cell={cell} />
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
