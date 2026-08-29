// Gemini CLI session-history source (ADR-0062, T3).
//
// On disk: `~/.gemini/tmp/<projectHash>/chats/*.jsonl` (JSONL). The first line is
// a metadata record { sessionId, projectHash, startTime, lastUpdated, summary?,
// directories, kind }; each following line is a MessageRecord:
//   { id, timestamp, content: Part[], type: "user"|"gemini"|"info"|"error",
//     toolCalls?: [{ id, name, args, result, status }], thoughts?, tokens?, model? }
// where a Part is { text } | { functionCall:{name,args} } | { functionResponse }.
// `$set` / `$rewindTo` are replayed with the same insertion-ordered semantics
// as Gemini's recording service. Official JSON content-array exports are also
// accepted; unlike JSONL recordings they do not carry resumable metadata.

import { joinPath } from "@/lib/claude/instructions/paths"
import type { ImportedConversation } from "@/lib/data/importers/types"
import type { StoredMessage } from "@cognia/agent-config-types"
import { walkFiles } from "../fs"
import { buildImportedSessionGraph } from "../graph"
import { importedUsageMetadata } from "../usage"
import {
  buildMessage,
  buildSession,
  deriveTitle,
  filePart,
  importedSessionId,
  reasoningPart,
  textPart,
  toolPart,
} from "../to-parts"
import type {
  AgentSessionSourceAdapter,
  PickedSessionFile,
  SessionRef,
  SessionScanInput,
  SessionSummary,
} from "../types"

type Part = StoredMessage["parts"][number]

interface GeminiToolCall {
  id?: string
  name?: string
  args?: unknown
  result?: unknown
  status?: string
  agentId?: string
  displayName?: string
  description?: string
  resultDisplay?: unknown
  renderOutputAsMarkdown?: boolean
}
interface GeminiRecord {
  sessionId?: string
  directories?: string[]
  startTime?: string
  lastUpdated?: string
  summary?: string
  memoryScratchpad?: string
  kind?: "main" | "subagent"
  messages?: GeminiRecord[]
  // message record:
  id?: string
  timestamp?: string
  content?: unknown
  displayContent?: unknown
  type?: string
  toolCalls?: GeminiToolCall[]
  thoughts?: Array<{ description?: string; subject?: string; text?: string }>
  tokens?: {
    input?: number
    output?: number
    total?: number
    cached?: number
    thoughts?: number
    tool?: number
  }
  model?: string
}

interface GeminiSetRecord {
  $set: Partial<GeminiRecord>
}

interface GeminiRewindRecord {
  $rewindTo: string
}

interface GeminiExportContent {
  role?: string
  parts?: unknown[]
}

const ACCEPTED = [".jsonl", ".json"]

/** Concatenate the `text` of a Gemini `Part[]` (functionCall/Response ignored). */
function partsText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((p) => p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => (p as { text: string }).text)
    .join("")
}

function contentParts(content: unknown, fallbackToolId: string): Part[] {
  if (typeof content === "string") return content ? [textPart(content)] : []
  if (!Array.isArray(content)) return []
  const parts: Part[] = []
  for (let index = 0; index < content.length; index++) {
    const value = content[index]
    if (!value || typeof value !== "object") continue
    const item = value as Record<string, unknown>
    if (typeof item.text === "string" && item.text) {
      parts.push(textPart(item.text))
      continue
    }
    const inline = item.inlineData
    if (inline && typeof inline === "object") {
      const data = inline as { mimeType?: unknown; data?: unknown }
      if (typeof data.mimeType === "string" && typeof data.data === "string") {
        parts.push(
          filePart({ mediaType: data.mimeType, url: `data:${data.mimeType};base64,${data.data}` })
        )
      }
      continue
    }
    const file = item.fileData
    if (file && typeof file === "object") {
      const data = file as { mimeType?: unknown; fileUri?: unknown }
      if (typeof data.fileUri === "string") {
        parts.push(
          filePart({
            mediaType:
              typeof data.mimeType === "string" ? data.mimeType : "application/octet-stream",
            url: data.fileUri,
          })
        )
      }
      continue
    }
    const call = item.functionCall
    if (call && typeof call === "object") {
      const data = call as { name?: unknown; args?: unknown; id?: unknown }
      const name = typeof data.name === "string" ? data.name : "tool"
      parts.push(
        toolPart({
          name,
          toolCallId: typeof data.id === "string" ? data.id : `${fallbackToolId}-${index}`,
          input: data.args ?? {},
        })
      )
      continue
    }
    const response = item.functionResponse
    if (response && typeof response === "object") {
      const data = response as { name?: unknown; response?: unknown; id?: unknown }
      const name = typeof data.name === "string" ? data.name : "tool"
      parts.push(
        toolPart({
          name,
          toolCallId: typeof data.id === "string" ? data.id : `${fallbackToolId}-${index}`,
          input: {},
          output: data.response ?? {},
        })
      )
    }
  }
  return parts
}

function resultToOutput(result: unknown): unknown {
  if (typeof result === "string") return result
  if (Array.isArray(result)) return partsText(result)
  return result ?? ""
}

function thoughtsText(thoughts: GeminiRecord["thoughts"]): string {
  if (!Array.isArray(thoughts)) return ""
  return thoughts
    .map((t) => t.text || t.description || t.subject || "")
    .filter(Boolean)
    .join("\n")
}

function tsToMs(ts: string | undefined, fallback: number): number {
  if (!ts) return fallback
  const n = Date.parse(ts)
  return Number.isNaN(n) ? fallback : n
}

interface ParsedSession {
  originalSessionId: string
  cwd?: string
  model?: string
  title: string
  messages: StoredMessage[]
  createdAt: number
  updatedAt: number
  kind?: "main" | "subagent"
  memoryScratchpad?: string
  summary?: string
}

function isSetRecord(record: unknown): record is GeminiSetRecord {
  return Boolean(
    record &&
    typeof record === "object" &&
    "$set" in record &&
    (record as GeminiSetRecord).$set &&
    typeof (record as GeminiSetRecord).$set === "object"
  )
}

function isRewindRecord(record: unknown): record is GeminiRewindRecord {
  return Boolean(
    record &&
    typeof record === "object" &&
    typeof (record as GeminiRewindRecord).$rewindTo === "string"
  )
}

function replayGeminiRecording(content: string): GeminiRecord[] {
  const trimmed = content.trim()
  if (!trimmed) return []

  try {
    const whole = JSON.parse(trimmed) as unknown
    if (Array.isArray(whole)) return exportContentsToRecords(whole as GeminiExportContent[])
    if (whole && typeof whole === "object" && Array.isArray((whole as GeminiRecord).messages)) {
      const record = whole as GeminiRecord
      return [{ ...record, messages: undefined }, ...(record.messages ?? [])]
    }
  } catch {
    // JSONL is intentionally not valid as one JSON document.
  }

  const metadata: GeminiRecord = {}
  const messages = new Map<string, GeminiRecord>()
  let anonymousIndex = 0
  for (const line of content.split("\n")) {
    const lineText = line.trim()
    if (!lineText) continue
    let record: unknown
    try {
      record = JSON.parse(lineText)
    } catch {
      continue
    }
    if (isRewindRecord(record)) {
      const ids = [...messages.keys()]
      const target = ids.indexOf(record.$rewindTo)
      if (target < 0) {
        messages.clear()
      } else {
        for (const id of ids.slice(target)) messages.delete(id)
      }
      continue
    }
    if (isSetRecord(record)) {
      const update = record.$set
      if (Array.isArray(update.messages)) {
        messages.clear()
        for (const message of update.messages) {
          const id = message.id || `anonymous-${anonymousIndex++}`
          messages.set(id, message)
        }
      }
      Object.assign(metadata, { ...update, messages: undefined })
      continue
    }
    const value = record as GeminiRecord
    if (value.type) {
      const id = value.id || `anonymous-${anonymousIndex++}`
      messages.set(id, value)
    } else {
      Object.assign(metadata, value)
    }
  }
  return [metadata, ...messages.values()]
}

function exportContentsToRecords(contents: GeminiExportContent[]): GeminiRecord[] {
  return contents.map((content, index) => ({
    id: `export-${index}`,
    type: content.role === "model" ? "gemini" : "user",
    content: content.parts ?? [],
  }))
}

export function parseGeminiChat(
  content: string,
  locatorId: string,
  projectId?: string
): ParsedSession {
  const records = replayGeminiRecording(content)

  let sessionId = ""
  let cwd: string | undefined
  let model: string | undefined
  let firstUserText = ""
  let createdAt = 0
  let updatedAt = 0
  let kind: ParsedSession["kind"]
  let memoryScratchpad: string | undefined
  let summary: string | undefined
  const messages: StoredMessage[] = []
  let counter = 0
  const finalId = () => importedSessionId("gemini-cli", sessionId || locatorId)

  for (const rec of records) {
    if (rec.sessionId && !sessionId) sessionId = rec.sessionId
    if (rec.directories?.[0]) cwd = rec.directories[0]
    if (rec.model) model = rec.model
    if (rec.kind) kind = rec.kind
    if (rec.memoryScratchpad !== undefined) memoryScratchpad = rec.memoryScratchpad
    if (rec.summary !== undefined) summary = rec.summary
    const ms = tsToMs(rec.timestamp || rec.startTime || rec.lastUpdated, updatedAt || Date.now())
    if (rec.timestamp || rec.startTime || rec.lastUpdated) {
      if (!createdAt) createdAt = ms
      updatedAt = Math.max(updatedAt, ms)
    }

    if (rec.type === "user") {
      const text = partsText(rec.content)
      if (!firstUserText) firstUserText = text
      const parts = contentParts(rec.displayContent ?? rec.content, rec.id || `user-${counter}`)
      if (parts.length === 0) continue
      messages.push(
        buildMessage({
          sessionId: finalId(),
          projectId,
          index: counter++,
          role: "user",
          parts,
          createdAt: ms,
        })
      )
      continue
    }

    if (rec.type === "gemini") {
      const parts: Part[] = []
      const thoughts = thoughtsText(rec.thoughts)
      if (thoughts) parts.push(reasoningPart(thoughts))
      parts.push(...contentParts(rec.displayContent ?? rec.content, rec.id || `gemini-${counter}`))
      for (const tc of rec.toolCalls ?? []) {
        const isError = tc.status === "error"
        const hasResult = tc.result !== undefined || isError
        const tool = toolPart({
          name: tc.name || "tool",
          toolCallId: tc.id || `call-${counter}-${parts.length}`,
          input: tc.args ?? {},
          ...(hasResult ? { output: resultToOutput(tc.result), isError } : {}),
        }) as Part & Record<string, unknown>
        if (tc.agentId) tool.agentId = tc.agentId
        if (tc.displayName) tool.displayName = tc.displayName
        if (tc.description) tool.description = tc.description
        if (tc.resultDisplay !== undefined) tool.resultDisplay = tc.resultDisplay
        if (tc.renderOutputAsMarkdown !== undefined) {
          tool.renderOutputAsMarkdown = tc.renderOutputAsMarkdown
        }
        parts.push(tool)
      }
      if (parts.length === 0) continue
      const usage = rec.tokens
        ? {
            ...importedUsageMetadata(
              {
                inputTokens: rec.tokens.input ?? 0,
                outputTokens: rec.tokens.output ?? 0,
                cacheReadInputTokens: rec.tokens.cached,
                reasoningTokens: rec.tokens.thoughts,
              },
              model
            ),
            geminiTokens: { tool: rec.tokens.tool, total: rec.tokens.total },
          }
        : model
          ? importedUsageMetadata({}, model)
          : undefined
      messages.push(
        buildMessage({
          sessionId: finalId(),
          projectId,
          index: counter++,
          role: "assistant",
          parts,
          createdAt: ms,
          ...(usage ? { metadata: usage } : {}),
        })
      )
      continue
    }

    if (rec.type === "info" || rec.type === "error" || rec.type === "warning") {
      const text = partsText(rec.content)
      if (!text) continue
      messages.push(
        buildMessage({
          sessionId: finalId(),
          projectId,
          index: counter++,
          role: "system",
          parts: [textPart(text)],
          createdAt: ms,
        })
      )
    }
  }

  const now = Date.now()
  return {
    originalSessionId: sessionId || locatorId,
    cwd,
    model,
    title: deriveTitle(firstUserText, "Gemini CLI session"),
    messages,
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
    kind,
    memoryScratchpad,
    summary,
  }
}

function summarize(parsed: ParsedSession, locator: string): SessionSummary {
  return {
    ref: { sourceId: "gemini-cli", originalSessionId: parsed.originalSessionId, locator },
    title: parsed.title,
    sourceId: "gemini-cli",
    messageCount: parsed.messages.length,
    updatedAt: parsed.updatedAt,
    cwd: parsed.cwd,
    relationKind: parsed.kind === "subagent" ? "subagent" : undefined,
    sourceVersion: geminiCliSessionSource.verifiedVersion,
  }
}

function inferParentNativeSessionId(locator: string, parsed: ParsedSession): string | undefined {
  if (parsed.kind !== "subagent") return undefined
  const normalized = locator.replace(/\\/g, "/")
  const pieces = normalized.split("/").filter(Boolean)
  return pieces.length > 1 ? pieces[pieces.length - 2] : undefined
}

function toConversation(parsed: ParsedSession, locator: string): ImportedConversation {
  const id = importedSessionId("gemini-cli", parsed.originalSessionId)
  const parentNativeSessionId = inferParentNativeSessionId(locator, parsed)
  const session = buildSession({
    id,
    title: parsed.title,
    model: parsed.model,
    workingDir: parsed.cwd,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    seedMessages: parsed.messages,
    kind: parsed.kind === "subagent" ? "subagent" : "direct",
    suppressSeed: parsed.kind === "subagent",
  })
  session.importRuntimeBinding = {
    presetId: "gemini-cli",
    nativeSessionId: parsed.originalSessionId,
    cwd: parsed.cwd,
  }
  if (parsed.memoryScratchpad) session.scratchpad = parsed.memoryScratchpad
  if (parsed.summary) {
    session.importCanonicalState = {
      history: [
        {
          historyId: `summary:${parsed.originalSessionId}`,
          kind: "compaction",
          summary: parsed.summary,
        },
      ],
    }
  }
  if (parentNativeSessionId) {
    session.parentSessionId = importedSessionId("gemini-cli", parentNativeSessionId)
    session.importRelation = {
      kind: "subagent",
      parentNativeSessionId,
    }
  }
  return { session, messages: parsed.messages }
}

function isAcceptedFile(name: string): boolean {
  const lower = name.toLowerCase()
  return ACCEPTED.some((extension) => lower.endsWith(extension))
}

export const geminiCliSessionSource: AgentSessionSourceAdapter = {
  id: "gemini-cli",
  displayName: "Gemini CLI",
  labelKey: "gemini-cli",
  verifiedVersion: "0.57.0",
  verifiedAt: "2026-08-29",
  acceptedExtensions: ACCEPTED,

  // `roots.geminiDir` first: it comes from the Rust resolver, which is the one
  // place in the app allowed to know where a vendor's tree really lives. This
  // adapter used to join onto a bare `home` — one of only two that still did.
  scanRoots(home, roots) {
    const base = roots?.geminiDir || (home ? joinPath(home, ".gemini") : "")
    return base ? [joinPath(base, "tmp")] : []
  },

  detect(files: PickedSessionFile[]) {
    if (files.length === 0) return "no"
    const hinted = files.filter((f) => f.path.replace(/\\/g, "/").includes(".gemini/tmp"))
    if (hinted.length > 0) return hinted.length === files.length ? "match" : "maybe"
    const looks = files.some((f) => {
      const first = f.content.split("\n").find((l) => l.trim())
      if (!first) return false
      try {
        const rec = JSON.parse(first) as GeminiRecord
        return typeof rec.sessionId === "string" && "projectHash" in (rec as object)
      } catch {
        return false
      }
    })
    return looks ? "maybe" : "no"
  },

  async listSessions(input: SessionScanInput) {
    if (input.pickedFiles?.length) {
      return input.pickedFiles
        .filter((f) => isAcceptedFile(f.name))
        .map((f) => summarize(parseGeminiChat(f.content, f.name), f.path))
        .filter((s) => s.messageCount > 0 && s.relationKind !== "subagent")
    }
    const summaries: SessionSummary[] = []
    for (const root of this.scanRoots(input.home, input.roots)) {
      const files = await walkFiles(input.fs, root, isAcceptedFile)
      for (const file of files) {
        try {
          const parsed = parseGeminiChat(await input.fs.readTextFile(file), file)
          const summary = summarize(parsed, file)
          if (parsed.messages.length > 0 && summary.relationKind !== "subagent") {
            summaries.push(summary)
          }
        } catch {
          // Skip unreadable chat.
        }
      }
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  },

  async parseSession(ref: SessionRef, input: SessionScanInput) {
    let content: string
    if (input.pickedFiles?.length) {
      content = input.pickedFiles.find((f) => f.path === ref.locator)?.content ?? ""
    } else {
      content = await input.fs.readTextFile(ref.locator)
    }
    const parsed = parseGeminiChat(content, ref.locator)
    const conversation = toConversation(parsed, ref.locator)
    const nested: ImportedConversation[] = []
    if (parsed.kind !== "subagent") {
      if (input.pickedFiles?.length) {
        for (const file of input.pickedFiles) {
          if (file.path === ref.locator || !isAcceptedFile(file.name)) continue
          const child = parseGeminiChat(file.content, file.path)
          if (
            child.kind === "subagent" &&
            inferParentNativeSessionId(file.path, child) === parsed.originalSessionId
          ) {
            nested.push(toConversation(child, file.path))
          }
        }
      } else {
        const chatDir = ref.locator.replace(/[\\/][^\\/]+$/, "")
        const childDir = joinPath(chatDir, parsed.originalSessionId)
        if (await input.fs.exists(childDir)) {
          const childFiles = await walkFiles(input.fs, childDir, isAcceptedFile)
          for (const file of childFiles) {
            try {
              const child = parseGeminiChat(await input.fs.readTextFile(file), file)
              if (child.kind === "subagent") nested.push(toConversation(child, file))
            } catch {
              // Keep a readable parent even when one child artifact is corrupt.
            }
          }
        }
      }
    }
    return nested.length > 0 ? { ...conversation, nested } : conversation
  },
  async parseGraph(ref: SessionRef, input: SessionScanInput) {
    return buildImportedSessionGraph(await this.parseSession(ref, input), {
      sourceRuntime: this.id,
      sourceVersion: this.verifiedVersion,
      verifiedAt: this.verifiedAt,
      importFidelity: "structured",
    })
  },
}
