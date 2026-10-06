/**
 * What an ACP `session/request_permission` is asking to run, for display.
 *
 * The spec puts a tool call's arguments in `rawInput`, but agents are free to
 * omit it, and some do exactly when it matters. Kimi Code CLI 2.1.1, captured
 * live over `kimi acp`, asks to run Bash like this:
 *
 * ```jsonc
 * // 1. announce, no arguments yet
 * {"sessionUpdate":"tool_call","toolCallId":"0:tool_R29…","title":"Bash","kind":"execute",
 *  "status":"pending","content":[{"type":"content","content":{"type":"text","text":""}}]}
 * // 2. stream the arguments as JSON TEXT, each update re-sending the whole prefix
 * {"sessionUpdate":"tool_call_update","toolCallId":"0:tool_R29…","status":"in_progress",
 *  "content":[{"type":"content","content":{"type":"text","text":"{\"command\":\"echo hi\"}"}}]}
 * // 3. ask, with neither rawInput nor kind
 * {"method":"session/request_permission","params":{"sessionId":"…","options":[…],
 *  "toolCall":{"toolCallId":"0:tool_R29…","title":"Bash","content":[{"type":"content",
 *  "content":{"type":"text","text":"Requesting approval to Running: echo hi"}}]}}}
 * // 4. only AFTER the answer does `rawInput: {"command":"echo hi"}` appear
 * ```
 *
 * Reading only `rawInput` therefore showed the user `{}` for the one question
 * that most needs its arguments. This module recovers them from the other
 * places the protocol allows: JSON text content (the request's own, then the
 * live tool-call state for the same `toolCallId`), diff content, and
 * locations — and keeps any plain prose the agent attached as a summary.
 *
 * Display only. Nothing here may feed a permission decision: policy keeps
 * reading the wire `rawInput`, so a recovered preview can never widen what an
 * allow-list approves.
 */

import type {
  AcpToolCallContent,
  AcpToolCallLocation,
} from "@cognia/agent-contracts/external-agent"

/** The tool-call fields a permission request may carry, or that were cached for it. */
export interface AcpPermissionToolCallFields {
  rawInput?: Record<string, unknown> | null
  content?: AcpToolCallContent[] | null
  locations?: AcpToolCallLocation[] | null
}

export interface AcpPermissionInputView {
  /**
   * Best available arguments: `rawInput` when the agent sent a non-empty one,
   * otherwise what could be recovered. Absent when nothing could.
   */
  input?: Record<string, unknown>
  /** Where `input` came from — for tests and diagnostics. */
  source?: "rawInput" | "content-json" | "diff" | "locations"
  /**
   * Prose the permission's own content carried (e.g. Kimi's "Requesting
   * approval to Running: echo hi"). JSON argument text is never a summary.
   */
  summary?: string
}

/**
 * Streamed argument text is parsed only up to this size. An agent that puts a
 * whole file into a text block is not sending arguments, and parsing it on the
 * UI thread just to throw it away is not worth the stall.
 */
const MAX_JSON_TEXT = 256 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0
}

/** Text of each `{type:"content", content:{type:"text"}}` block, in order. */
function textBlocks(content: AcpToolCallContent[] | null | undefined): string[] {
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== "content") continue
    const inner = (block as { content?: unknown }).content
    if (isRecord(inner) && inner.type === "text" && typeof inner.text === "string") {
      out.push(inner.text)
    }
  }
  return out
}

/** A text block that is a complete JSON object with at least one key. */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}") || trimmed.length > MAX_JSON_TEXT) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isNonEmptyRecord(parsed) ? parsed : undefined
  } catch {
    // A partial stream (`{"command":"echo`) is not arguments yet.
    return undefined
  }
}

function jsonFromContent(
  content: AcpToolCallContent[] | null | undefined
): Record<string, unknown> | undefined {
  for (const text of textBlocks(content)) {
    const parsed = parseJsonObject(text)
    if (parsed) return parsed
  }
  return undefined
}

/**
 * Diff entries in the Edit/MultiEdit shape the approval preview already
 * renders as a diff, so an ACP edit and a Claude edit look the same.
 */
function inputFromDiffs(
  content: AcpToolCallContent[] | null | undefined
): Record<string, unknown> | undefined {
  if (!Array.isArray(content)) return undefined
  const edits = content.flatMap((block) =>
    isRecord(block) &&
    block.type === "diff" &&
    typeof block.path === "string" &&
    typeof block.newText === "string"
      ? [
          {
            file_path: block.path,
            old_string: typeof block.oldText === "string" ? block.oldText : "",
            new_string: block.newText,
          },
        ]
      : []
  )
  if (edits.length === 0) return undefined
  if (edits.length === 1) return edits[0]
  const paths = new Set(edits.map((edit) => edit.file_path))
  return paths.size === 1 ? { file_path: edits[0].file_path, edits } : { edits }
}

function inputFromLocations(
  locations: AcpToolCallLocation[] | null | undefined
): Record<string, unknown> | undefined {
  if (!Array.isArray(locations)) return undefined
  const valid = locations.filter(
    (location): location is AcpToolCallLocation =>
      isRecord(location) && typeof location.path === "string" && location.path.length > 0
  )
  if (valid.length === 0) return undefined
  if (valid.length === 1) {
    const [only] = valid
    return typeof only.line === "number"
      ? { path: only.path, line: only.line }
      : { path: only.path }
  }
  return { paths: valid.map((location) => location.path) }
}

function summaryFrom(content: AcpToolCallContent[] | null | undefined): string | undefined {
  const prose = textBlocks(content)
    .map((text) => text.trim())
    .filter((text) => text.length > 0 && !parseJsonObject(text))
  return prose.length > 0 ? prose.join("\n") : undefined
}

/**
 * Resolve what a permission request is asking to run.
 *
 * `request` is the permission's own ToolCallUpdate (newest, wins); `cached`
 * is the session's live state for the same `toolCallId`, merged from the
 * earlier `tool_call` / `tool_call_update` notifications.
 */
export function deriveAcpPermissionInput(
  request: AcpPermissionToolCallFields,
  cached?: AcpPermissionToolCallFields
): AcpPermissionInputView {
  const summary = summaryFrom(request.content)
  const withSummary = (view: AcpPermissionInputView): AcpPermissionInputView =>
    summary ? { ...view, summary } : view

  for (const rawInput of [request.rawInput, cached?.rawInput]) {
    if (isNonEmptyRecord(rawInput)) return withSummary({ input: rawInput, source: "rawInput" })
  }
  for (const content of [request.content, cached?.content]) {
    const parsed = jsonFromContent(content)
    if (parsed) return withSummary({ input: parsed, source: "content-json" })
  }
  for (const content of [request.content, cached?.content]) {
    const diff = inputFromDiffs(content)
    if (diff) return withSummary({ input: diff, source: "diff" })
  }
  for (const locations of [request.locations, cached?.locations]) {
    const fromLocations = inputFromLocations(locations)
    if (fromLocations) return withSummary({ input: fromLocations, source: "locations" })
  }
  return withSummary({})
}
