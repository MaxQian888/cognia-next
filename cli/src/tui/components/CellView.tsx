/**
 * Renders one transcript cell. A thin switch over the cell kinds — the
 * substance (markdown tokenizing, diff formatting, tool summaries, todo parsing)
 * lives in the pure `markdown/*` and `format/*` modules.
 */
import React from "react"
import { Box, Text } from "ink"
import { Spinner } from "./Spinner"

import { Markdown } from "./Markdown"
import { DiffView } from "./DiffView"
import { useTheme } from "../theme/context"
import { useRenderPrefs } from "../render/context"
import { useElapsedSeconds } from "../render/use-elapsed-seconds"
import { sanitizeCell } from "../render/sanitize-cell"
import { diffFilePath, formatEditDiff } from "../markdown/diff"
import { truncateToWidth } from "../markdown/width"
import { langFromPath } from "../markdown/highlight"
import { renderResultLines, toolResultLang } from "../format/result-render"
import {
  extractResultImages,
  elideImageData,
  formatBytes,
  type ExtractedImage,
} from "../format/result-images"
import { buildImageEscape, detectGraphics } from "../format/terminal-graphics"
import {
  isDiffTool,
  resultPreview,
  toolResultPreviewText,
  summarizeToolCall,
  toolFileLine,
  toolFilePath,
  toolGlyph,
  toolHeaderLabel,
  toolKind,
} from "../format/tools"
import {
  describeToolResult,
  formatResultDescriptor,
  isDetailDescriptor,
  type ResultTone,
  type ToolResultDescriptor,
} from "../format/tool-result"
import {
  isSubagentTool,
  subagentDispatchCount,
  subagentName,
  subagentTask,
} from "../format/subagent"
import { isContextTool } from "../format/context-group"
import { planStats, planTitle } from "../runtime/plan"
import { fileUri } from "../runtime/editor"
import { osc8Link, supportsHyperlinks } from "../markdown/hyperlink"
import path from "node:path"
import type {
  AssistantCell,
  Cell,
  BashCell,
  CanonicalEventCell,
  CommentaryCell,
  ContentPartCell,
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

function AssistantView({ cell, columns }: { cell: AssistantCell; columns: number }) {
  return <Markdown raw={cell.raw} columns={columns} />
}

function ThinkingView({ cell, columns }: { cell: ThinkingCell; columns: number }) {
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
          <Markdown raw={cell.text} columns={columns} />
        </Box>
      )}
    </Box>
  )
}

const STATUS_ICON: Record<ToolCell["status"], string> = {
  running: "⏳",
  done: "✓",
  error: "✗",
  cancelled: "○",
}

/** Generic cancellation text is lifecycle metadata, not useful tool output. */
function isUserCancellationResult(cell: ToolCell): boolean {
  if (cell.status !== "cancelled" || typeof cell.result !== "string") return false
  return /^cancell?ed by user\.?$/i.test(cell.result.trim())
}

/** The leading status glyph for a tool/subagent card: an animated spinner while
 * running (in the live region), else the static ✓/✗ icon. */
function StatusGlyph({ status, color }: { status: ToolCell["status"]; color: string }) {
  if (status === "running") {
    return (
      <Text color={color}>
        <Spinner />{" "}
      </Text>
    )
  }
  return <Text color={color}>{STATUS_ICON[status]} </Text>
}

/** A dim "· Ns" elapsed-time hint, shown only while a tool is running. */
function ElapsedHint({ status }: { status: ToolCell["status"] }) {
  const theme = useTheme()
  const elapsed = useElapsedSeconds(status === "running")
  if (status !== "running" || elapsed <= 0) return null
  return (
    <Text color={theme.muted} dimColor>
      {" "}
      · {elapsed}s
    </Text>
  )
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

/**
 * Wrap a tool card's summary in an OSC-8 hyperlink to the file it references, so
 * a terminal click opens the editor. Returns the plain summary unchanged when
 * the tool has no file path or the terminal can't render hyperlinks (no escape
 * bytes leak). VS Code's integrated terminal opens `vscode://file/…:line`; other
 * terminals get a `file://` URL handled by the OS.
 */
function linkifyToolSummary(cell: ToolCell, summary: string): string {
  if (!summary) return summary
  const filePath = toolFilePath(cell.toolName, cell.input)
  if (!filePath || !supportsHyperlinks(process.env)) return summary
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
  const vscodeTerm = (process.env.TERM_PROGRAM ?? "").toLowerCase() === "vscode"
  const line = toolFileLine(cell.toolName, cell.input)
  return osc8Link(fileUri(abs, line, vscodeTerm ? "vscode" : "generic"), summary, true)
}

/** Colour of a result chip by tone. Neutral chips stay dim so a settled card
 * reads as one quiet row, while a diff's +/- keeps its diff colour. */
function toneColor(tone: ResultTone, theme: ReturnType<typeof useTheme>): string {
  return tone === "success" ? theme.diffAdded : tone === "error" ? theme.danger : theme.muted
}

/** The header's right-hand chip: "12 matches", "+5 -2", "320 lines". Errors are
 * excluded by {@link isDetailDescriptor} and render on the detail line instead,
 * where the message gets the full row width. */
function ResultChip({ descriptor }: { descriptor: ToolResultDescriptor }) {
  const theme = useTheme()
  return (
    <Text color={toneColor(descriptor.tone, theme)} dimColor={descriptor.tone === "neutral"}>
      {" "}
      · {formatResultDescriptor(descriptor)}
    </Text>
  )
}

/** The disclosure caret. Printed only when the card actually has a body to
 * reveal, so a bodyless call is not advertising an expansion that does nothing.
 * The caret is the whole affordance: the command that opens the body
 * (`/inspect`) is already advertised once in the footer hint, and repeating it
 * on every settled row buried the transcript it was meant to make legible. */
function Disclosure({ shown, collapsed }: { shown: boolean; collapsed: boolean }) {
  const theme = useTheme()
  if (!shown) return null
  return (
    <Text color={theme.muted} dimColor>
      {collapsed ? "▸ " : "▾ "}
    </Text>
  )
}

/** The indented body of an expanded card: a left rule that ties the output to
 * its header, the terminal counterpart of the web row's `border-l` nest. */
function CardBody({ children }: { children: React.ReactNode }) {
  const theme = useTheme()
  return (
    // marginLeft 2 + the 1-cell border + paddingLeft 1 puts the rule directly
    // under the header's caret and costs exactly the 4 columns the written-block
    // renderer's `  │ ` prefix costs, so both layouts wrap a body identically.
    <Box
      flexDirection="column"
      marginLeft={2}
      paddingLeft={1}
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={theme.borderSubtle}
    >
      {children}
    </Box>
  )
}

function ToolView({ cell, columns }: { cell: ToolCell; columns: number }) {
  const theme = useTheme()
  const STATUS_COLOR: Record<ToolCell["status"], string> = {
    running: theme.statusRunning,
    done: theme.statusDone,
    error: theme.statusError,
    cancelled: theme.muted,
  }
  const summary = summarizeToolCall(cell.toolName, cell.input)
  const hasUsefulResult = cell.result != null && !isUserCancellationResult(cell)
  // Make the file path a clickable OSC-8 hyperlink so a Ctrl/Cmd-click opens it
  // in the editor (vscode://file inside a VS Code terminal, else file://). Only
  // on terminals with confirmed OSC-8 support: the link bytes are zero-width, so
  // the displayed text and column math are unchanged.
  const summaryDisplay = linkifyToolSummary(cell, summary)
  const diff = isDiffTool(cell.toolName) ? formatEditDiff(cell.toolName, cell.input) : []
  const diffLang = diff.length > 0 ? langFromPath(diffFilePath(cell.input) ?? "") : undefined
  // One descriptor answers "what did this produce" for both TUI renderers and
  // for the web row, so the same call reads the same everywhere.
  const descriptor = describeToolResult(cell)
  const chip = descriptor && !isDetailDescriptor(descriptor) ? descriptor : null
  // A failure's first line, and the first line of a result whose header chip
  // only carries a size. Both land under the header where they have room.
  const detail =
    descriptor && isDetailDescriptor(descriptor)
      ? { text: formatResultDescriptor(descriptor), tone: descriptor.tone }
      : cell.collapsed &&
          cell.status === "done" &&
          cell.result != null &&
          // A context tool's chip already says how much came back, and the first
          // line of a file or a match list adds nothing. Preview the tools whose
          // output IS the answer (a shell command, an MCP call) instead.
          !isContextTool(cell.toolName)
        ? { text: resultPreview(cell.result), tone: "neutral" as ResultTone }
        : null
  // A diff renders whether or not the card is collapsed, so only a hidden result
  // body makes the card collapsible. Showing a caret next to an always-visible
  // diff would advertise an expansion that reveals nothing.
  const collapsible = diff.length === 0 && hasUsefulResult
  // Some protocol adapters supply neither a usable input summary nor a result.
  // Say so, instead of reducing a settled card to a bare tool name.
  const missingDetails =
    (cell.status === "done" || cell.status === "error") && !summary && !chip && !detail?.text
      ? cell.status === "error"
        ? "failed · no error details"
        : "completed · no details"
      : ""
  return (
    <Box flexDirection="column">
      <Text>
        <StatusGlyph status={cell.status} color={STATUS_COLOR[cell.status]} />
        <Disclosure shown={collapsible} collapsed={cell.collapsed} />
        <ToolBadge toolName={cell.toolName} />
        <Text color={theme.muted}>{toolGlyph(cell.toolName)} </Text>
        {/* Label from the protocol when there is one, canonical name otherwise.
            `cell.toolName` still drives every formatter above. */}
        <Text bold>{cell.displayTitle ?? toolHeaderLabel(cell.toolName)}</Text>
        {summary ? <Text color={theme.text}> {summaryDisplay}</Text> : null}
        {cell.status === "cancelled" ? <Text color={theme.muted}> · stopped</Text> : null}
        <ElapsedHint status={cell.status} />
        {chip ? <ResultChip descriptor={chip} /> : null}
        {missingDetails ? (
          <Text color={cell.status === "error" ? theme.danger : theme.muted} dimColor>
            {" "}
            · {missingDetails}
          </Text>
        ) : null}
      </Text>
      {cell.collapsed && detail?.text ? (
        <Box paddingLeft={2}>
          <Text color={detail.tone === "error" ? theme.danger : theme.text}>↳ {detail.text}</Text>
        </Box>
      ) : null}
      {diff.length > 0 ? (
        <CardBody>
          <DiffView diff={diff} lang={diffLang} />
        </CardBody>
      ) : null}
      {!cell.collapsed && diff.length === 0 && hasUsefulResult ? (
        <CardBody>
          <ToolResult
            columns={columns}
            result={cell.result}
            lang={toolResultLang(cell.toolName, cell.input)}
          />
        </CardBody>
      ) : null}
    </Box>
  )
}

/**
 * Expanded tool result = any inline images (rendered as graphics) plus the
 * textual body with image base64 elided, so an image result no longer floods
 * the transcript with a base64 wall.
 */
function ToolResult({
  result,
  lang,
  columns,
}: {
  result: unknown
  lang?: string
  columns: number
}) {
  const images = extractResultImages(result)
  if (images.length === 0) return <ResultBody columns={columns} result={result} lang={lang} />
  return (
    <Box flexDirection="column">
      <ToolImages images={images} />
      <ResultBody columns={columns} result={elideImageData(result)} lang={lang} />
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
function ResultBody({
  result,
  lang,
  columns,
}: {
  result: unknown
  lang?: string
  columns: number
}) {
  const theme = useTheme()
  const prefs = useRenderPrefs()
  const text = toolResultPreviewText(result)
  if (!text) return null

  const totalLines = text.split("\n").length
  const colored = prefs.syntaxHighlightInline && Boolean(lang)
  const tooBig = totalLines > prefs.pagerThresholdLines
  const maxLines = tooBig ? Math.min(prefs.toolResultMaxLines, 20) : prefs.toolResultMaxLines

  const bodyWidth = Math.max(
    1,
    columns - 4 - (prefs.fileLineNumbers ? String(totalLines).length + 3 : 0)
  )
  const rawLines = text.split("\n")
  const visibleLines = rawLines.slice(0, maxLines > 0 ? maxLines : rawLines.length)
  const fittedLines = visibleLines.map((line) => truncateToWidth(line, bodyWidth))
  const clipped = fittedLines.some((line, index) => line !== visibleLines[index])
  const rendered = renderResultLines(fittedLines.join("\n"), {
    lang,
    highlight: prefs.syntaxHighlightInline,
    lineNumbers: prefs.fileLineNumbers,
    palette: theme,
    maxLines,
  })

  const hiddenLines = totalLines - rendered.lines.length
  return (
    <Box flexDirection="column">
      {rendered.lines.map((line, i) =>
        colored ? (
          <Text key={i}>{line}</Text>
        ) : (
          <Text key={i} color={theme.text}>
            {line}
          </Text>
        )
      )}
      {clipped ? <Text color={theme.warning}>/expand · long lines shortened</Text> : null}
      {tooBig ? (
        <Text color={theme.warning} dimColor>
          {`… ${totalLines} lines total — open full output: /expand`}
        </Text>
      ) : hiddenLines > 0 ? (
        <Text color={theme.warning} dimColor>
          {`… +${hiddenLines} more line${hiddenLines === 1 ? "" : "s"} hidden — /expand`}
        </Text>
      ) : null}
    </Box>
  )
}

const SUBAGENT_STATUS_LABEL: Record<ToolCell["status"], string> = {
  running: "running",
  done: "done",
  error: "failed",
  cancelled: "stopped",
}

/**
 * A sub-agent dispatch (`task` / `dispatch_agent` / `agent`) rendered as a
 * first-class, inline-indented unit — a `◆` marker, the agent's name, the task
 * it was handed, a status badge, and (when expanded) its reply. The data all
 * rides the normal {@link ToolCell} pipeline; this view just frames it like a
 * delegated agent instead of an opaque tool card.
 */
function SubagentView({ cell, columns }: { cell: ToolCell; columns: number }) {
  const theme = useTheme()
  const STATUS_COLOR: Record<ToolCell["status"], string> = {
    running: theme.statusRunning,
    done: theme.statusDone,
    error: theme.statusError,
    cancelled: theme.muted,
  }
  const name = subagentName(cell.input)
  const task = subagentTask(cell.input)
  const dispatchCount = subagentDispatchCount(cell.input)
  const hasUsefulResult = cell.result != null && !isUserCancellationResult(cell)
  const descriptor = describeToolResult(cell)
  const chip = descriptor && !isDetailDescriptor(descriptor) ? descriptor : null
  const detail =
    descriptor && isDetailDescriptor(descriptor)
      ? { text: formatResultDescriptor(descriptor), tone: descriptor.tone }
      : cell.collapsed && cell.status === "done" && cell.result != null
        ? { text: resultPreview(cell.result), tone: "neutral" as ResultTone }
        : null
  return (
    <Box flexDirection="column">
      <Text>
        <StatusGlyph status={cell.status} color={STATUS_COLOR[cell.status]} />
        <Disclosure shown={hasUsefulResult} collapsed={cell.collapsed} />
        <Text color={theme.accent} bold>
          ◆ {name}
        </Text>
        <Text color={theme.muted} dimColor={cell.status !== "cancelled"}>
          {" "}
          {dispatchCount > 1 ? `parallel batch · ${dispatchCount} agents` : "subagent"} ·{" "}
          {SUBAGENT_STATUS_LABEL[cell.status]}
        </Text>
        <ElapsedHint status={cell.status} />
        {chip ? <ResultChip descriptor={chip} /> : null}
      </Text>
      {task ? (
        <Box paddingLeft={2}>
          <Text color={theme.muted}>{task}</Text>
        </Box>
      ) : null}
      {cell.collapsed && detail?.text ? (
        <Box paddingLeft={2}>
          <Text color={detail.tone === "error" ? theme.danger : theme.text}>↳ {detail.text}</Text>
        </Box>
      ) : null}
      {!cell.collapsed && hasUsefulResult ? (
        <CardBody>
          <ToolResult columns={columns} result={cell.result} />
        </CardBody>
      ) : null}
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
 * the user is meant to review and approve (vs. an ordinary reply). Compact by
 * design: the full plan renders as a scrollable body inside the approval overlay
 * (see `PlanApprovalOverlay`), so this transcript cell is just a reference line —
 * the persistent full text stays reachable via `/plan`. */
function PlanView({ cell }: { cell: PlanCell }) {
  const theme = useTheme()
  const { steps, lines } = planStats(cell.raw)
  const title = planTitle(cell.raw)
  const size = steps > 0 ? `${steps} step${steps === 1 ? "" : "s"}` : `${lines} lines`
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text color={theme.accent} bold>
        📋 Plan ready for review
      </Text>
      <Text color={theme.muted} dimColor>
        {`${title} · ${size} · review & approve below · full text via /plan`}
      </Text>
    </Box>
  )
}

function ErrorView({ cell }: { cell: ErrorCell }) {
  const theme = useTheme()
  // A classified error carries a remediation hint — render it dim on a second
  // line under the message so the fix is right there (not just the raw fault).
  if (cell.hint) {
    return (
      <Box flexDirection="column">
        <Text color={theme.danger}>✗ {cell.message}</Text>
        <Text color={theme.muted} dimColor>
          {"  ↳ "}
          {cell.hint}
        </Text>
      </Box>
    )
  }
  return <Text color={theme.danger}>✗ {cell.message}</Text>
}

function NoticeView({ cell }: { cell: NoticeCell }) {
  const theme = useTheme()
  if (cell.tone === "interrupted") {
    return (
      <Text>
        <Text color={theme.muted}>── </Text>
        <Text color={theme.warning}>Turn stopped by user</Text>
        <Text color={theme.muted}> ──</Text>
      </Text>
    )
  }
  return (
    <Text color={theme.muted} dimColor>
      • {cell.message}
    </Text>
  )
}

function CommentaryView({ cell, columns }: { cell: CommentaryCell; columns: number }) {
  const theme = useTheme()
  return (
    <Box flexDirection="column">
      <Text color={theme.secondary} dimColor>
        {cell.done ? "◆" : "◇"} commentary
      </Text>
      <Box paddingLeft={2}>
        <Markdown raw={cell.text} streaming={!cell.done} columns={columns} />
      </Box>
    </Box>
  )
}

function ContentPartView({ cell }: { cell: ContentPartCell }) {
  const theme = useTheme()
  const part = cell.part
  switch (part.type) {
    case "sources":
      return (
        <Box flexDirection="column">
          <Text color={theme.secondary} bold>
            Sources ({part.sources.length})
          </Text>
          {part.sources.map((source, index) => {
            const label = source.title ?? source.origin ?? source.url ?? source.id
            const display =
              source.url && supportsHyperlinks(process.env) ? osc8Link(source.url, label) : label
            return (
              <Text key={source.id} color={theme.muted}>
                [{index + 1}] {display}
                {typeof source.score === "number" ? ` · ${Math.round(source.score * 100)}%` : ""}
                {source.snippet ? ` — ${source.snippet}` : ""}
              </Text>
            )
          })}
        </Box>
      )
    case "file":
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
          <Text bold>
            File · {part.name}
            {part.mediaType ? ` · ${part.mediaType}` : ""}
            {typeof part.size === "number" ? ` · ${formatBytes(part.size)}` : ""}
          </Text>
          <Text color={theme.muted}>{part.uri}</Text>
          {part.preview ? <Text>{part.preview}</Text> : null}
          <Text color={theme.accent} dimColor>
            /open {cell.partId} · /view {cell.partId}
          </Text>
        </Box>
      )
    case "a2ui":
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
          <Text color={theme.accent} bold>
            A2UI surface · {part.surfaceId}
          </Text>
          <Text color={theme.muted}>
            Source: {part.source} · open with /view {cell.partId}
          </Text>
        </Box>
      )
    case "artifact-ref":
      return (
        <Text color={theme.secondary}>
          Artifact · {part.title ?? part.artifactId} · /view {cell.partId}
        </Text>
      )
    case "canvas-ref":
      return (
        <Text color={theme.secondary}>
          Canvas · {part.title ?? part.canvasId} · /open {cell.partId}
        </Text>
      )
    case "custom":
      return (
        <Box flexDirection="column">
          <Text color={theme.secondary} bold>
            {part.customType}
          </Text>
          <Text color={theme.muted}>{part.summary}</Text>
          <Text color={theme.accent} dimColor>
            Structured fallback · /view {cell.partId}
          </Text>
        </Box>
      )
  }
}

function CanonicalEventView({ cell }: { cell: CanonicalEventCell }) {
  const theme = useTheme()
  const color =
    cell.level === "error" ? theme.danger : cell.level === "warning" ? theme.warning : theme.muted
  return (
    <Text color={color} dimColor={cell.level === "info"}>
      {cell.level === "error" ? "✗" : cell.level === "warning" ? "⚠" : "•"} {cell.title}:{" "}
      {cell.summary}
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
        {cell.status === "running" ? (
          <Text color={theme.statusRunning}> {cell.background ? "(background) …" : "…"}</Text>
        ) : null}
      </Text>
      {cell.output ? (
        <Text color={color} dimColor>
          {cell.output}
        </Text>
      ) : null}
      {cell.status === "running" ? (
        <Text color={theme.muted} dimColor>
          {cell.background
            ? "/bashes to view · kill · foreground"
            : "Ctrl+C kill · Ctrl+B background"}
        </Text>
      ) : null}
    </Box>
  )
}

export function CellView({ cell, columns = 80 }: { cell: Cell; columns?: number }) {
  cell = sanitizeCell(cell)
  switch (cell.kind) {
    case "user":
      return <UserView cell={cell} />
    case "assistant":
      return <AssistantView cell={cell} columns={columns} />
    case "thinking":
      return <ThinkingView cell={cell} columns={columns} />
    case "tool":
      return isSubagentTool(cell.toolName) ? (
        <SubagentView cell={cell} columns={columns} />
      ) : (
        <ToolView cell={cell} columns={columns} />
      )
    case "todo":
      return <TodoView cell={cell} />
    case "plan":
      return <PlanView cell={cell} />
    case "error":
      return <ErrorView cell={cell} />
    case "notice":
      return <NoticeView cell={cell} />
    case "commentary":
      return <CommentaryView cell={cell} columns={columns} />
    case "content-part":
      return <ContentPartView cell={cell} />
    case "canonical-event":
      return <CanonicalEventView cell={cell} />
    case "bash":
      return <BashView cell={cell} />
  }
}
