/**
 * Pi session-history reader (ADR-0119, ADR-0062, ADR-0217).
 *
 * Reads the JSONL files Pi writes under
 * `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl`. The wire format is
 * taken from the `docs/session-format.md` that ships inside
 * `@earendil-works/pi-coding-agent`, so the entry names below are
 * authoritative rather than inferred from one sample file.
 *
 * Three properties of Pi's format shape this reader:
 *
 *   - **It is a tree, not a list.** `/fork`, `/clone` and `/tree` branch in
 *     place. The active leaf becomes the main transcript; every other leaf is
 *     returned as a branch so abandoned work is not silently dropped (see
 *     `./session-tree`).
 *   - **Three format versions exist.** v1 is a linear legacy sequence, v2
 *     introduced the tree, v3 renamed the `hookMessage` role to `custom`. Pi
 *     migrates old files on load; because Cognia reads them directly it must
 *     accept all three rather than only the current one.
 *   - **`custom` entries never reach the LLM.** They are extension state, and
 *     Pi's own context builder excludes them. They are reported as a loss
 *     rather than rendered, so the report stays honest without inventing turns
 *     the model never saw.
 *
 * Pure functions over file content: the host finds and reads the files and
 * maps the result into its own rows.
 */

import type { SessionLossEntry } from "@cognia/agent-contracts/canonical-session"
import type {
  HistoryDetectVerdict,
  HistoryFormatInfo,
  HistoryMessage,
  HistoryPart,
  HistoryPickedFile,
  HistorySessionSummary,
  HistoryToolPart,
  HistoryUsage,
  ParsedHistorySession,
} from "@cognia/agent-contracts/history"
import {
  deriveTitle,
  historyFile,
  historyReasoning,
  historyText,
  historyTool,
  stringifyToolResult,
} from "@cognia/agent-runtime-kit/history"
import { PI_SESSION_SOURCE_ID } from "./manifest"
import { piSessionTree } from "./session-tree"

/** The Pi version this reader was last verified against. */
export const PI_HISTORY_FORMAT: HistoryFormatInfo = Object.freeze({
  sourceId: PI_SESSION_SOURCE_ID,
  verifiedVersion: "1.0.2",
  verifiedAt: "2026-10-05",
  acceptedExtensions: Object.freeze([".jsonl"]),
})

/** Format versions this reader knows how to read. */
export const PI_SUPPORTED_SESSION_VERSIONS: ReadonlySet<number> = new Set([1, 2, 3])

// ============================================================================
// Wire types (docs/session-format.md and pi-ai declarations, Pi 1.0.2)
// ============================================================================

export interface PiHeader {
  type: "session"
  version?: number
  id?: string
  timestamp?: string
  cwd?: string
  /** Absolute path of the session this one was forked/cloned from. */
  parentSession?: string
}

export interface PiContentBlock {
  type?: string
  text?: string
  thinking?: string
  data?: string
  mimeType?: string
  id?: string
  name?: string
  arguments?: Record<string, unknown>
}

export interface PiMessage {
  role?: string
  content?: string | PiContentBlock[]
  toolCallId?: string
  toolName?: string
  isError?: boolean
  /** Pi records bounded child-call metadata, but never the child results. */
  nestedCalls?: { calls: unknown[]; complete: boolean }
  provider?: string
  model?: string
  usage?: Record<string, unknown>
  command?: string
  output?: string
}

export interface PiEntry {
  type?: string
  id?: string
  parentId?: string | null
  timestamp?: string
  message?: PiMessage
  provider?: string
  modelId?: string
  thinkingLevel?: string
  summary?: string
  customType?: string
  content?: string | PiContentBlock[]
  name?: string
}

// ============================================================================
// Parsing
// ============================================================================

export interface ParsedPiFile {
  header: PiHeader | null
  entries: PiEntry[]
  /** Entry types that carry meaning Cognia cannot represent. */
  unrepresented: Map<string, number>
  corruptLines: number
}

/**
 * Parse a Pi JSONL file, skipping unparseable lines rather than failing.
 *
 * A single truncated line — common when Pi is killed mid-write — must not cost
 * the user the rest of the transcript.
 */
export function parsePiSessionFile(content: string): ParsedPiFile {
  const entries: PiEntry[] = []
  const unrepresented = new Map<string, number>()
  let header: PiHeader | null = null
  let corruptLines = 0

  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      corruptLines++
      continue
    }
    // Arrays are `typeof "object"` too, so they need an explicit reject —
    // otherwise one would flow on as an entry with no `type` and be counted
    // as an unknown entry rather than as the malformed line it is.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      corruptLines++
      continue
    }
    const entry = parsed as PiEntry
    if (entry.type === "session") {
      header = parsed as PiHeader
      continue
    }
    entries.push(entry)
  }

  return { header, entries, unrepresented, corruptLines }
}

/** Is this a Pi session file the reader can read? */
export function isSupportedPiHeader(header: PiHeader | null): boolean {
  if (!header) return false
  // A missing version predates the field; those files are v1-shaped.
  return PI_SUPPORTED_SESSION_VERSIONS.has(header.version ?? 1)
}

function contentBlocks(content: string | PiContentBlock[] | undefined): PiContentBlock[] {
  if (!content) return []
  if (typeof content === "string") return [{ type: "text", text: content }]
  return Array.isArray(content) ? content : []
}

function blocksToParts(blocks: PiContentBlock[]): HistoryPart[] {
  const parts: HistoryPart[] = []
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (block.text) parts.push(historyText(block.text))
        break
      case "thinking":
        if (block.thinking) parts.push(historyReasoning(block.thinking))
        break
      case "image":
        if (block.data) {
          parts.push(
            historyFile({
              mediaType: block.mimeType ?? "image/png",
              url: `data:${block.mimeType ?? "image/png"};base64,${block.data}`,
            })
          )
        }
        break
      case "toolCall":
        if (block.id) {
          parts.push(
            historyTool({
              name: block.name ?? "unknown",
              toolCallId: block.id,
              input: block.arguments ?? {},
            })
          )
        }
        break
      default:
        break
    }
  }
  return parts
}

function plainText(parts: readonly HistoryPart[]): string {
  return parts.map((part) => (part.type === "text" ? part.text : "")).join("")
}

/**
 * Pi's on-disk token counts as neutral usage.
 *
 * Pi writes `{ input, output, cacheRead, cacheWrite, cost: { total } }`;
 * legacy import files may instead carry numeric `costUsd` or `cost`.
 * Passing the raw blob through — as the app's adapter once did, alone among
 * the seven readers — produced a usage row per assistant turn whose every
 * figure was ZERO while the session still reported imported usage, so the
 * Insights sheet showed Pi sessions an imported-spend section full of zeros.
 *
 * Reasoning tokens are folded into output, matching the OpenCode reader and
 * the live adapters (they are billed as output). A turn with a model but no
 * counts keeps the model as a `model` annotation.
 */
function usageFields(
  message: PiMessage
): Pick<HistoryMessage, "usage" | "usageModel" | "annotations"> {
  const raw = message.usage
  const num = (...keys: string[]): number => {
    for (const key of keys) {
      const value = raw?.[key]
      if (typeof value === "number" && Number.isFinite(value)) return value
    }
    return 0
  }
  const hasUsage = !!raw && typeof raw === "object" && Object.keys(raw).length > 0
  if (!hasUsage) return message.model ? { annotations: { model: message.model } } : {}

  const nativeCost = raw?.cost
  const cost = [
    raw?.costUsd,
    raw?.totalCostUsd,
    nativeCost && typeof nativeCost === "object"
      ? (nativeCost as Record<string, unknown>).total
      : nativeCost,
  ].find(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0
  )
  const usage: HistoryUsage = {
    inputTokens: num("input", "inputTokens", "promptTokens"),
    outputTokens: num("output", "outputTokens", "completionTokens") + num("reasoning"),
    cacheReadInputTokens: num("cacheRead", "cacheReadInputTokens"),
    cacheCreationInputTokens: num("cacheWrite", "cacheCreationInputTokens"),
    ...(cost !== undefined ? { totalCostUsd: cost } : {}),
  }
  return { usage, ...(message.model ? { usageModel: message.model } : {}) }
}

interface BuiltTurns {
  messages: HistoryMessage[]
  firstUserText: string
  model?: string
  /** Count per kind of entry the transcript could not represent exactly. */
  lossy: Map<string, number>
}

function isToolPart(part: HistoryPart): part is HistoryToolPart {
  return part.type === "tool"
}

/**
 * Convert one root→leaf entry chain into neutral messages.
 *
 * Tool results are folded back onto the assistant turn that called them, so a
 * transcript renders as one assistant message with resolved tool parts rather
 * than an assistant turn followed by orphan "tool" rows.
 */
function buildTurns(chain: readonly PiEntry[]): BuiltTurns {
  const messages: HistoryMessage[] = []
  const lossy = new Map<string, number>()
  let firstUserText = ""
  let model: string | undefined

  /** toolCallId → the message index holding its call part. */
  const toolOwner = new Map<string, number>()

  const note = (kind: string) => lossy.set(kind, (lossy.get(kind) ?? 0) + 1)

  for (const entry of chain) {
    const createdAt = Date.parse(entry.timestamp ?? "") || Date.now()

    switch (entry.type) {
      case "message": {
        const message = entry.message ?? {}
        const role = message.role

        if (role === "toolResult") {
          // Attach to the assistant turn that issued the call.
          const ownerIndex = message.toolCallId ? toolOwner.get(message.toolCallId) : undefined
          const owner = ownerIndex !== undefined ? messages[ownerIndex] : undefined
          const resultParts = blocksToParts(contentBlocks(message.content))
          const resultText = plainText(resultParts)
          const attachments = resultParts.filter((part) => part.type === "file")
          // Structured output survives the canonical codec's resultText JSON
          // conversion. Do not invent separate child results: Pi does not store them.
          const output: unknown = message.nestedCalls
            ? { text: resultText, nestedCalls: message.nestedCalls }
            : resultText
          if (message.nestedCalls?.complete === false) note("incomplete_nested_calls")
          if (owner) {
            owner.parts = owner.parts.flatMap((part) => {
              if (!isToolPart(part) || part.toolCallId !== message.toolCallId) return [part]
              return [
                historyTool({
                  name: message.toolName ?? "unknown",
                  toolCallId: message.toolCallId!,
                  input: part.input,
                  result:
                    message.isError === true
                      ? { ok: false, errorText: stringifyToolResult(output) }
                      : { ok: true, output },
                }),
                ...attachments,
              ]
            })
          } else {
            // No matching call — keep the output rather than dropping it.
            messages.push({
              role: "assistant",
              parts: [
                historyText(typeof output === "string" ? output : JSON.stringify(output)),
                ...attachments,
              ],
              createdAt,
            })
            note("orphan_tool_result")
          }
          break
        }

        if (role === "bashExecution") {
          // A direct `!command` the user ran; Pi records it as its own role.
          // The fallback call id counts from 1 at the first message.
          messages.push({
            role: "assistant",
            parts: [
              historyTool({
                name: "bash",
                toolCallId: entry.id ?? `bash-${messages.length + 1}`,
                input: { command: message.command ?? "" },
                ...(message.output !== undefined
                  ? { result: { ok: true as const, output: message.output } }
                  : {}),
              }),
            ],
            createdAt,
          })
          break
        }

        const parts = blocksToParts(contentBlocks(message.content))
        if (parts.length === 0) break

        if (role === "assistant" && message.model) {
          model = message.provider ? `${message.provider}/${message.model}` : message.model
        }
        if (role === "user" && !firstUserText) firstUserText = plainText(parts)

        messages.push({
          role: role === "user" ? "user" : "assistant",
          parts,
          createdAt,
          ...usageFields(message),
        })
        for (const part of parts) {
          if (isToolPart(part)) toolOwner.set(part.toolCallId, messages.length - 1)
        }
        break
      }

      case "custom_message": {
        // Extension-injected context that DID reach the model, so it belongs
        // in the transcript.
        const parts = blocksToParts(contentBlocks(entry.content))
        if (parts.length > 0) messages.push({ role: "assistant", parts, createdAt })
        break
      }

      case "compaction":
      case "branch_summary":
        if (entry.summary) {
          messages.push({ role: "assistant", parts: [historyText(entry.summary)], createdAt })
        }
        break

      case "model_change":
        if (entry.modelId) {
          model = entry.provider ? `${entry.provider}/${entry.modelId}` : entry.modelId
        }
        break

      case "thinking_level_change":
      case "label":
      case "session_info":
        // Metadata with no transcript equivalent, and no model-visible content.
        break

      case "custom":
        // Extension state. Pi's own context builder excludes these, so they
        // never reached the model — reported, never rendered.
        note(`custom:${entry.customType ?? "unknown"}`)
        break

      default:
        note(`unknown:${entry.type ?? "untyped"}`)
        break
    }
  }

  return { messages, firstUserText, model, lossy }
}

/** The import notes of one transcript as loss entries. */
function lossesFromNotes(notes: Readonly<Record<string, number>>): SessionLossEntry[] {
  return Object.entries(notes).map(([note, count]): SessionLossEntry => {
    if (note === "corrupt_lines") {
      return {
        path: "lines",
        kind: "dropped",
        detail: `${count} unparseable line(s), typically a write cut short, were skipped.`,
      }
    }
    if (note === "incomplete_nested_calls") {
      return {
        path: "entries.toolResult.nestedCalls",
        kind: "summarized",
        detail: `${count} tool result(s) carry only part of their nested calls; Pi stores no child results.`,
      }
    }
    if (note === "orphan_tool_result") {
      return {
        path: "entries.toolResult",
        kind: "approximated",
        detail: `${count} tool result(s) whose call is not on this branch import as assistant text.`,
      }
    }
    if (note.startsWith("custom:")) {
      return {
        path: `entries.custom.${note.slice("custom:".length)}`,
        kind: "dropped",
        detail: `${count} Pi extension state entr(ies) never reached the model and are not imported.`,
      }
    }
    const type = note.startsWith("unknown:") ? note.slice("unknown:".length) : note
    return {
      path: `entries.${type}`,
      kind: "dropped",
      detail: `${count} Pi "${type}" entr(ies) have no Cognia equivalent.`,
    }
  })
}

/** The fork origin a header names: the parent file's name without `.jsonl`. */
function parentNativeSessionId(header: PiHeader | null): string | undefined {
  if (!header?.parentSession) return undefined
  const parentFile = header.parentSession.replace(/\\/g, "/").split("/").pop() ?? ""
  return parentFile.replace(/\.jsonl$/i, "") || undefined
}

function emptyStructuredState(): Pick<
  ParsedHistorySession,
  "goals" | "plans" | "tasks" | "history" | "interAgentMessages" | "recordedEvents"
> {
  return {
    goals: [],
    plans: [],
    tasks: [],
    history: [],
    interAgentMessages: [],
    recordedEvents: [],
  }
}

/** An alternate leaf of the tree, read as its own transcript. */
export interface PiHistoryBranch {
  /** The leaf entry id; the host derives the branch session's id from it. */
  leafId: string
  session: ParsedHistorySession
}

/** One Pi file: its active transcript, its other branches, and file facts. */
export interface ParsedPiHistory {
  /** The active leaf's root→leaf transcript. */
  session: ParsedHistorySession
  /** Every other leaf with a visible transcript, newest first. */
  branches: PiHistoryBranch[]
  /** The header's format version (1 when the header predates the field). */
  sessionVersion: number
  /** The absolute path of the session this one was forked or cloned from. */
  forkedFrom?: string
}

/**
 * Read one Pi session file. `fallbackSessionId` names the session when the
 * header carries no id (the host passes the file's locator).
 *
 * Import notes (what the transcript could not represent, the fork origin) ride
 * the FIRST message as a `piImport` annotation, because a session row has no
 * metadata field of its own; the same notes are also returned as losses.
 */
export function readPiSession(content: string, fallbackSessionId: string): ParsedPiHistory {
  const { header, entries, corruptLines } = parsePiSessionFile(content)
  const nativeSessionId = header?.id ?? fallbackSessionId
  const sessionVersion = header?.version ?? 1
  const tree = piSessionTree(entries)
  const main = buildTurns(tree.activeChain)

  const createdAt = Date.parse(header?.timestamp ?? "") || Date.now()
  const updatedAt =
    main.messages.length > 0 ? main.messages[main.messages.length - 1]!.createdAt : createdAt

  const notes: Record<string, number> = Object.fromEntries(main.lossy)
  if (corruptLines > 0) notes.corrupt_lines = corruptLines
  const hasNotes = Object.keys(notes).length > 0
  // The fork origin is independent of whether the file also had losses, so
  // gating it on the notes would drop it for every clean forked session.
  if (main.messages.length > 0 && (hasNotes || header?.parentSession)) {
    const first = main.messages[0]!
    first.annotations = {
      ...first.annotations,
      piImport: {
        sessionVersion,
        ...(header?.parentSession ? { forkedFrom: header.parentSession } : {}),
        ...(hasNotes ? { notes } : {}),
      },
    }
  }

  const forkParent = parentNativeSessionId(header)
  const session: ParsedHistorySession = {
    sourceId: PI_SESSION_SOURCE_ID,
    originalSessionId: nativeSessionId,
    ...(header?.cwd ? { cwd: header.cwd } : {}),
    ...(main.model ? { model: main.model } : {}),
    title: deriveTitle(main.firstUserText, "Pi session"),
    messages: main.messages,
    createdAt,
    updatedAt,
    ...(header?.parentSession
      ? {
          relationKind: "fork" as const,
          ...(forkParent ? { parentNativeSessionId: forkParent } : {}),
        }
      : {}),
    ...emptyStructuredState(),
    losses: lossesFromNotes(notes),
  }

  // Alternate leaves are branches the user can still reach in Pi's `/tree`.
  const branches: PiHistoryBranch[] = []
  for (const leafId of tree.alternateLeafIds) {
    const chain = tree.chainToLeaf(leafId)
    if (chain.length === 0) continue
    const branch = buildTurns(chain)
    if (branch.messages.length === 0) continue
    if (branch.lossy.size > 0) {
      const first = branch.messages[0]!
      first.annotations = {
        ...first.annotations,
        piImport: { sessionVersion, notes: Object.fromEntries(branch.lossy) },
      }
    }
    branches.push({
      leafId,
      session: {
        sourceId: PI_SESSION_SOURCE_ID,
        originalSessionId: nativeSessionId,
        ...(header?.cwd ? { cwd: header.cwd } : {}),
        ...(branch.model ? { model: branch.model } : {}),
        title: deriveTitle(branch.firstUserText, "Pi branch"),
        messages: branch.messages,
        createdAt,
        updatedAt: branch.messages[branch.messages.length - 1]!.createdAt,
        relationKind: "branch",
        parentNativeSessionId: nativeSessionId,
        ...emptyStructuredState(),
        losses: lossesFromNotes(Object.fromEntries(branch.lossy)),
      },
    })
  }

  return {
    session,
    branches,
    sessionVersion,
    ...(header?.parentSession ? { forkedFrom: header.parentSession } : {}),
  }
}

// ============================================================================
// Summaries and detection
// ============================================================================

/** Cheap single-pass summary for a picker (no message allocation). */
export function summarizePiSession(content: string, locator: string): HistorySessionSummary | null {
  const { header, entries } = parsePiSessionFile(content)
  if (!isSupportedPiHeader(header)) return null

  let firstUserText = ""
  let messageCount = 0
  let lastTimestamp = header?.timestamp ?? ""

  for (const entry of entries) {
    if (entry.timestamp) lastTimestamp = entry.timestamp
    if (entry.type !== "message") continue
    messageCount++
    if (!firstUserText && entry.message?.role === "user") {
      firstUserText = plainText(blocksToParts(contentBlocks(entry.message.content)))
    }
  }

  if (messageCount === 0) return null

  const createdAt = Date.parse(header?.timestamp ?? "") || Date.now()
  return {
    sourceId: PI_SESSION_SOURCE_ID,
    originalSessionId: header?.id ?? locator,
    title: deriveTitle(firstUserText, "Pi session"),
    messageCount,
    updatedAt: Date.parse(lastTimestamp) || createdAt,
    ...(header?.cwd ? { cwd: header.cwd } : {}),
  }
}

function pathSep(path: string): string {
  return path.includes("\\") ? "\\" : "/"
}

/**
 * Whether picked files are Pi sessions: a path under `.pi/agent`, or a first
 * line that is a `session` header carrying `cwd`.
 */
export function detectPiSession(files: readonly HistoryPickedFile[]): HistoryDetectVerdict {
  if (files.some((file) => file.path.includes(`.pi${pathSep(file.path)}agent`))) return "match"
  const sniffed = files.some((file) => {
    const first = file.content.split("\n").find((line) => line.trim())
    if (!first) return false
    try {
      const parsed = JSON.parse(first) as PiHeader
      return parsed.type === "session" && typeof parsed.cwd === "string"
    } catch {
      return false
    }
  })
  return sniffed ? "match" : "no"
}
