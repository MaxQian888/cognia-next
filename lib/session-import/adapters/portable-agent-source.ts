import type { ImportedConversation } from "@/lib/data/importers/types"
import type { StoredMessage } from "@cognia/agent-config-types"
import { redactText } from "@cognia/redact"
import type {
  CanonicalCheckpoint,
  CanonicalHistoryEvent,
  CanonicalRecordedEvent,
  CanonicalSessionLifecycle,
  CanonicalSessionTask,
  SessionFidelity,
  SessionLossEntry,
} from "@cognia/agent-config-types/canonical-session"

import { walkFiles } from "../fs"
import { buildImportedSessionGraph } from "../graph"
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

export interface PortableSourceConfig {
  id: string
  displayName: string
  verifiedVersion: string
  /** Matching configured runtime preset, when native resume is supported. */
  presetId?: string
  acceptedExtensions: string[]
  roots: (home: string) => string[]
  pathHints: string[]
  contentHints?: string[]
  /** Read-only desktop SQLite projection supplied by the Tauri store transport. */
  storeSource?: "cursor" | "cline" | "copilot-cli"
  defaultTitle: string
  fidelity?: SessionFidelity
  markdown?: boolean
}

function stableLocatorKey(locator: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < locator.length; index += 1) {
    hash ^= locator.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

export interface PortableParsedSession {
  originalSessionId: string
  parentNativeSessionId?: string
  relationKind?: "branch" | "fork" | "subagent" | "background" | "team-member"
  cwd?: string
  model?: string
  title: string
  createdAt: number
  updatedAt: number
  lifecycle?: CanonicalSessionLifecycle
  messages: StoredMessage[]
  tasks: CanonicalSessionTask[]
  checkpoints: CanonicalCheckpoint[]
  history: CanonicalHistoryEvent[]
  recordedEvents: CanonicalRecordedEvent[]
  losses: SessionLossEntry[]
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function string(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function number(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isNaN(parsed) ? 0 : parsed
}

function status(value: unknown): CanonicalSessionLifecycle["status"] {
  const normalized = string(value).toLowerCase()
  if (["complete", "completed", "done", "success"].includes(normalized)) return "completed"
  if (["failed", "error"].includes(normalized)) return "failed"
  if (["cancelled", "canceled"].includes(normalized)) return "cancelled"
  if (["interrupted", "aborted"].includes(normalized)) return "interrupted"
  if (normalized === "waiting") return "waiting"
  if (normalized === "pending") return "pending"
  return "running"
}

function safeDiagnostic(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]"
  if (typeof value === "string") {
    const bounded = value.length > 1000 ? `${value.slice(0, 1000)}…` : value
    return redactText(bounded).redacted
  }
  if (!value || typeof value !== "object") return value
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeDiagnostic(item, depth + 1))
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value).slice(0, 30)) {
    output[key] = /token|secret|password|authorization|api[_-]?key/i.test(key)
      ? "[redacted]"
      : safeDiagnostic(child, depth + 1)
  }
  return output
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((item) => {
      const value = record(item)
      return string(value.text) || string(record(value.content).text)
    })
    .filter(Boolean)
    .join("\n")
}

function partsOf(content: unknown, toolId: string): Part[] {
  if (typeof content === "string") return content ? [textPart(content)] : []
  if (!Array.isArray(content)) return []
  const parts: Part[] = []
  for (let index = 0; index < content.length; index += 1) {
    const value = record(content[index])
    const type = string(value.type)
    const text = string(value.text) || string(record(value.content).text)
    if ((type === "thinking" || type === "reasoning") && text) {
      parts.push(reasoningPart(text))
      continue
    }
    if (text) {
      parts.push(textPart(text))
      continue
    }
    const url = string(value.url) || string(value.uri) || string(record(value.image_url).url)
    if (url) {
      parts.push(
        filePart({
          mediaType: string(value.mime) || string(value.mediaType) || "application/octet-stream",
          url,
          filename: string(value.name) || string(value.filename) || undefined,
        })
      )
      continue
    }
    const call = record(value.functionCall)
    if (type === "tool_call" || type === "tool_use" || Object.keys(call).length > 0) {
      const source = Object.keys(call).length > 0 ? call : value
      parts.push(
        toolPart({
          name: string(source.name) || string(source.toolName) || "tool",
          toolCallId: string(source.id) || string(source.callId) || `${toolId}-${index}`,
          input: record(source.input ?? source.arguments ?? source.args),
        })
      )
    }
  }
  return parts
}

function parseDocument(content: string): { documents: unknown[]; invalidLineCount: number } {
  const trimmed = content.trim()
  if (!trimmed) return { documents: [], invalidLineCount: 0 }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed)) {
      const sessionArray = parsed.every((item) => {
        const value = record(item)
        return (
          Array.isArray(value.messages) && Boolean(value.sessionId || value.session_id || value.id)
        )
      })
      return { documents: sessionArray ? parsed : [{ messages: parsed }], invalidLineCount: 0 }
    }
    const root = record(parsed)
    if (Array.isArray(root.sessions)) {
      return { documents: root.sessions as unknown[], invalidLineCount: 0 }
    }
    return { documents: [root], invalidLineCount: 0 }
  } catch {
    const records: unknown[] = []
    let invalidLineCount = 0
    for (const line of content.split("\n")) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line) as unknown)
      } catch {
        invalidLineCount += 1
      }
    }
    return {
      documents: records.length > 0 ? [{ events: records }] : [],
      invalidLineCount,
    }
  }
}

function markdownMessages(content: string): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = []
  let role: "user" | "assistant" | null = null
  let buffer: string[] = []
  const flush = () => {
    const text = buffer.join("\n").trim()
    if (role && text) messages.push({ role, content: text })
    buffer = []
  }
  for (const line of content.split("\n")) {
    const match = /^(?:#{1,4}\s*|\*\*)?(user|human|assistant|agent)(?:\*\*)?\s*:?(.*)$/i.exec(line)
    if (match) {
      flush()
      role = /user|human/i.test(match[1]) ? "user" : "assistant"
      if (match[2].trim()) buffer.push(match[2].trim())
    } else if (role) {
      buffer.push(line)
    }
  }
  flush()
  return messages
}

function locatorId(locator: string): string {
  const normalized = locator.replace(/\\/g, "/")
  const name = normalized.split("/").pop() ?? locator
  if (/^(?:manifest|messages|events|api_conversation_history)\.(?:jsonl?|txt)$/i.test(name)) {
    const parent = normalized.split("/").slice(-2, -1)[0]
    if (parent) return parent
  }
  return name.replace(/\.(?:jsonl?|md|txt)$/i, "") || locator
}

export function parsePortableAgentArtifact(
  config: PortableSourceConfig,
  content: string,
  locator: string
): PortableParsedSession[] {
  const markdown = config.markdown && /\.md$/i.test(locator)
  const parsedDocument = markdown
    ? { documents: [{ messages: markdownMessages(content) }], invalidLineCount: 0 }
    : parseDocument(content)
  const documents = parsedDocument.documents
  const parsed: PortableParsedSession[] = []

  for (const [documentIndex, document] of documents.entries()) {
    const root = record(document)
    const metadata = record(root.session ?? root.metadata ?? root.manifest)
    const merged = { ...metadata, ...root }
    const originalSessionId =
      string(merged.sessionId) ||
      string(merged.session_id) ||
      string(merged.conversationId) ||
      string(merged.id) ||
      (documents.length > 1 ? `${locatorId(locator)}-${documentIndex}` : locatorId(locator))
    const sessionId = importedSessionId(config.id, originalSessionId)
    const artifactKey = stableLocatorKey(locator)
    const rawMessages = Array.isArray(root.messages)
      ? root.messages
      : Array.isArray(root.events)
        ? root.events
        : []
    const messages: StoredMessage[] = []
    const toolIndex = new Map<string, { message: number; part: number }>()
    const tasks: CanonicalSessionTask[] = []
    const checkpoints: CanonicalCheckpoint[] = []
    const history: CanonicalHistoryEvent[] = []
    const recordedEvents: CanonicalRecordedEvent[] = []
    const losses: SessionLossEntry[] = []
    let firstUserText = ""
    let createdAt = number(merged.startedAt ?? merged.createdAt ?? merged.timestamp)
    let updatedAt = number(merged.endedAt ?? merged.updatedAt ?? merged.lastUpdated)
    let eventSequence = 0

    for (const raw of rawMessages) {
      const envelope = record(raw)
      const value = { ...envelope, ...record(envelope.payload ?? envelope.data) }
      const type = string(value.type ?? value.event).toLowerCase()
      const role = string(value.role).toLowerCase()
      const at =
        number(value.timestamp ?? value.createdAt ?? value.created_at) ||
        updatedAt ||
        createdAt ||
        Date.now()
      if (!createdAt) createdAt = at
      updatedAt = Math.max(updatedAt, at)

      if (type === "tool_result" || role === "tool") {
        const callId = string(value.toolCallId ?? value.callId ?? value.tool_use_id)
        const owner = toolIndex.get(callId)
        if (owner) {
          const current = messages[owner.message].parts[owner.part] as Record<string, unknown>
          const output = value.output ?? value.result ?? value.content
          const isError = value.isError === true || string(value.status) === "failed"
          messages[owner.message].parts[owner.part] = {
            ...current,
            state: isError ? "output-error" : "output-available",
            ...(isError ? { errorText: textOf(output) || JSON.stringify(output) } : { output }),
          } as unknown as Part
        }
        continue
      }

      if (["checkpoint", "restore_point"].includes(type)) {
        checkpoints.push({
          checkpointId: string(value.id) || `checkpoint-${checkpoints.length + 1}`,
          afterTurnId: string(value.turnId) || messages.at(-1)?.id || "unknown",
          note: string(value.summary ?? value.description) || undefined,
        })
        continue
      }
      if (["rewind", "rollback", "branch", "fork", "compaction", "compact"].includes(type)) {
        const kind = type === "compact" ? "compaction" : (type as CanonicalHistoryEvent["kind"])
        history.push({
          historyId: string(value.id) || `${kind}-${history.length + 1}`,
          kind,
          at: new Date(at).toISOString(),
          summary: string(value.summary ?? value.description) || undefined,
        })
        continue
      }
      if (["task", "subagent", "background_job", "team_task"].includes(type)) {
        const taskId = string(value.taskId ?? value.id) || `task-${tasks.length + 1}`
        tasks.push({
          taskId,
          description: string(value.prompt ?? value.description ?? value.title) || undefined,
          status: status(value.status),
          background: type === "background_job" || value.background === true,
          dependencies: Array.isArray(value.dependencies)
            ? value.dependencies.map(string).filter(Boolean)
            : undefined,
          childCanonicalSessionId: string(value.childSessionId)
            ? `canon:${config.id}:${importedSessionId(config.id, string(value.childSessionId))}`
            : undefined,
        })
        continue
      }

      const inferredRole =
        role || (type.includes("assistant") ? "assistant" : type.includes("user") ? "user" : "")
      if (inferredRole === "user" || inferredRole === "assistant" || inferredRole === "system") {
        const contentValue = value.content ?? value.message ?? value.parts ?? value.text
        const parts = partsOf(contentValue, string(value.id) || `turn-${messages.length}`)
        const calls = Array.isArray(value.toolCalls) ? value.toolCalls : []
        for (const [callIndex, callValue] of calls.entries()) {
          const call = record(callValue)
          const fn = record(call.function)
          const callId = string(call.id ?? call.callId) || `call-${messages.length}-${callIndex}`
          parts.push(
            toolPart({
              name: string(call.name) || string(fn.name) || "tool",
              toolCallId: callId,
              input: record(call.input ?? call.arguments ?? fn.arguments),
            })
          )
        }
        if (parts.length === 0) continue
        if (inferredRole === "user" && !firstUserText) firstUserText = textOf(contentValue)
        messages.push(
          buildMessage({
            id: `${sessionId}:${string(value.id) || `${artifactKey}:${documentIndex}:m${messages.length}`}`,
            sessionId,
            index: messages.length,
            role: inferredRole,
            parts,
            createdAt: at,
            metadata:
              string(value.model ?? merged.model) || value.usage
                ? {
                    ...(string(value.model ?? merged.model)
                      ? { model: string(value.model ?? merged.model) }
                      : {}),
                    ...(value.usage && typeof value.usage === "object"
                      ? { usage: value.usage }
                      : {}),
                  }
                : undefined,
          })
        )
        for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
          const callId = string((parts[partIndex] as Record<string, unknown>).toolCallId)
          if (callId) toolIndex.set(callId, { message: messages.length - 1, part: partIndex })
        }
        continue
      }

      if (type) {
        recordedEvents.push({
          eventId: `${config.id}-event-${eventSequence}`,
          sequence: eventSequence++,
          at: new Date(at).toISOString(),
          event: { kind: "diagnostic", runtime: config.id, payload: safeDiagnostic(value) },
        })
        losses.push({
          path: `events.${type}`,
          kind: "approximated",
          detail: "Unknown source event retained as a bounded redacted diagnostic.",
        })
      }
    }

    if (parsedDocument.invalidLineCount > 0) {
      losses.push({
        path: "jsonl",
        kind: "dropped",
        detail: `${parsedDocument.invalidLineCount} unparseable JSONL record(s).`,
      })
    }
    if (markdown) {
      losses.push({
        path: "markdown",
        kind: "summarized",
        detail: "Markdown export has no structured tool, task, lifecycle, or token data.",
      })
    }
    const parentNativeSessionId =
      string(merged.parentSessionId) || string(merged.parent_session_id) || string(merged.parentId)
    const kind = string(merged.kind).toLowerCase()
    const relationKind = parentNativeSessionId
      ? kind.includes("team")
        ? "team-member"
        : merged.background === true
          ? "background"
          : kind.includes("branch")
            ? "branch"
            : kind.includes("fork")
              ? "fork"
              : "subagent"
      : undefined
    const lifecycle = merged.status
      ? {
          status: status(merged.status),
          background: merged.background === true,
          startedAt: string(merged.startedAt) || undefined,
          endedAt: string(merged.endedAt) || undefined,
          error: string(merged.error) || undefined,
        }
      : undefined
    const now = Date.now()
    parsed.push({
      originalSessionId,
      parentNativeSessionId: parentNativeSessionId || undefined,
      relationKind,
      cwd: string(merged.cwd ?? merged.workspaceRoot ?? merged.workspace) || undefined,
      model: string(merged.model) || undefined,
      title:
        string(merged.title ?? merged.name ?? merged.summary) ||
        deriveTitle(firstUserText, config.defaultTitle),
      createdAt: createdAt || now,
      updatedAt: updatedAt || createdAt || now,
      lifecycle,
      messages,
      tasks,
      checkpoints,
      history,
      recordedEvents,
      losses,
    })
  }
  return parsed
}

function toConversation(
  config: PortableSourceConfig,
  parsed: PortableParsedSession
): ImportedConversation {
  const id = importedSessionId(config.id, parsed.originalSessionId)
  const session = buildSession({
    id,
    title: parsed.title,
    model: parsed.model,
    workingDir: parsed.cwd,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    seedMessages: parsed.messages,
    kind: parsed.relationKind === "subagent" ? "subagent" : "direct",
    suppressSeed: parsed.relationKind === "subagent",
  })
  session.importRuntimeBinding = {
    ...(config.presetId ? { presetId: config.presetId } : {}),
    nativeSessionId: parsed.originalSessionId,
    cwd: parsed.cwd,
    resumeMethod: "cli",
    verifiedAt: "2026-08-29",
  }
  if (parsed.parentNativeSessionId && parsed.relationKind) {
    session.parentSessionId = importedSessionId(config.id, parsed.parentNativeSessionId)
    session.importRelation = {
      kind: parsed.relationKind,
      parentNativeSessionId: parsed.parentNativeSessionId,
    }
  }
  if (parsed.lifecycle) session.importLifecycle = parsed.lifecycle
  return { session, messages: parsed.messages }
}

function extensionAccepted(config: PortableSourceConfig, name: string): boolean {
  const lower = name.toLowerCase()
  return config.acceptedExtensions.some((extension) => lower.endsWith(extension))
}

async function collectArtifacts(
  config: PortableSourceConfig,
  input: SessionScanInput
): Promise<Array<{ locator: string; content: string }>> {
  if (input.pickedFiles?.length) {
    return input.pickedFiles
      .filter((file) => extensionAccepted(config, file.name))
      .map((file) => ({ locator: file.path, content: file.content }))
  }
  const artifacts: Array<{ locator: string; content: string }> = []
  if (config.storeSource) {
    const { isTauri, transport } = await import("@/lib/tauri")
    if (isTauri()) {
      const stored = await transport.call<unknown[]>("external_agent_sessions_read", {
        source: config.storeSource,
        home: input.home,
      })
      for (const [index, value] of stored.entries()) {
        const id = string(record(value).sessionId ?? record(value).id) || String(index)
        artifacts.push({
          locator: `store:${config.id}:${id}.json`,
          content: JSON.stringify(value),
        })
      }
    }
  }
  for (const root of config.roots(input.home)) {
    const files = await walkFiles(input.fs, root, (name) => extensionAccepted(config, name))
    for (const locator of files) {
      try {
        artifacts.push({ locator, content: await input.fs.readTextFile(locator) })
      } catch {
        // One locked or concurrently-written artifact does not sink the scan.
      }
    }
  }
  return artifacts
}

async function collectParsed(
  config: PortableSourceConfig,
  input: SessionScanInput
): Promise<PortableParsedSession[]> {
  const sessions = new Map<string, PortableParsedSession>()
  for (const artifact of await collectArtifacts(config, input)) {
    for (const incoming of parsePortableAgentArtifact(config, artifact.content, artifact.locator)) {
      const current = sessions.get(incoming.originalSessionId)
      if (!current) {
        sessions.set(incoming.originalSessionId, incoming)
        continue
      }
      const messages = new Map(current.messages.map((message) => [message.id, message]))
      for (const message of incoming.messages) messages.set(message.id, message)
      sessions.set(incoming.originalSessionId, {
        ...current,
        ...incoming,
        parentNativeSessionId: incoming.parentNativeSessionId ?? current.parentNativeSessionId,
        relationKind: incoming.relationKind ?? current.relationKind,
        cwd: incoming.cwd ?? current.cwd,
        model: incoming.model ?? current.model,
        title:
          current.title !== config.defaultTitle && current.title !== "Untitled"
            ? current.title
            : incoming.title,
        createdAt: Math.min(current.createdAt, incoming.createdAt),
        updatedAt: Math.max(current.updatedAt, incoming.updatedAt),
        lifecycle: incoming.lifecycle ?? current.lifecycle,
        messages: [...messages.values()].sort((a, b) => a.createdAt - b.createdAt),
        tasks: [...current.tasks, ...incoming.tasks],
        checkpoints: [...current.checkpoints, ...incoming.checkpoints],
        history: [...current.history, ...incoming.history],
        recordedEvents: [...current.recordedEvents, ...incoming.recordedEvents],
        losses: [...current.losses, ...incoming.losses],
      })
    }
  }
  return [...sessions.values()].filter(
    (session) => session.messages.length > 0 || session.tasks.length > 0
  )
}

function attachTree(
  config: PortableSourceConfig,
  root: PortableParsedSession,
  sessions: PortableParsedSession[]
): ImportedConversation {
  const byParent = new Map<string, PortableParsedSession[]>()
  for (const session of sessions) {
    if (!session.parentNativeSessionId) continue
    const children = byParent.get(session.parentNativeSessionId) ?? []
    children.push(session)
    byParent.set(session.parentNativeSessionId, children)
  }
  const build = (session: PortableParsedSession, seen: Set<string>): ImportedConversation => {
    const conversation = toConversation(config, session)
    if (seen.has(session.originalSessionId)) return conversation
    const nextSeen = new Set(seen).add(session.originalSessionId)
    const nested = (byParent.get(session.originalSessionId) ?? []).map((child) =>
      build(child, nextSeen)
    )
    if (nested.length > 0) conversation.nested = nested
    return conversation
  }
  return build(root, new Set())
}

export function createPortableAgentSessionSource(
  config: PortableSourceConfig
): AgentSessionSourceAdapter {
  return {
    id: config.id,
    displayName: config.displayName,
    labelKey: config.id,
    verifiedVersion: config.verifiedVersion,
    verifiedAt: "2026-08-29",
    acceptedExtensions: config.acceptedExtensions,
    scanRoots: (home) => config.roots(home),
    detect(files: PickedSessionFile[]) {
      if (files.length === 0) return "no"
      if (
        files.some((file) =>
          config.pathHints.some((hint) => file.path.toLowerCase().includes(hint))
        )
      ) {
        return "match"
      }
      const looks = files.some((file) => {
        const haystack = `${file.name}\n${file.content.slice(0, 16_384)}`.toLowerCase()
        return (config.contentHints ?? []).some((hint) => haystack.includes(hint.toLowerCase()))
      })
      return looks ? "maybe" : "no"
    },
    async listSessions(input: SessionScanInput): Promise<SessionSummary[]> {
      const sessions = await collectParsed(config, input)
      const known = new Set(sessions.map((session) => session.originalSessionId))
      return sessions
        .filter(
          (session) => !session.parentNativeSessionId || !known.has(session.parentNativeSessionId)
        )
        .map((session) => ({
          ref: {
            sourceId: config.id,
            originalSessionId: session.originalSessionId,
            locator: session.originalSessionId,
          },
          title: session.title,
          sourceId: config.id,
          messageCount: session.messages.length,
          updatedAt: session.updatedAt,
          cwd: session.cwd,
          sourceVersion: config.verifiedVersion,
          relationKind: session.relationKind,
          lifecycleStatus: session.lifecycle?.status,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },
    async parseSession(ref: SessionRef, input: SessionScanInput): Promise<ImportedConversation> {
      const sessions = await collectParsed(config, input)
      const found = sessions.find((session) => session.originalSessionId === ref.originalSessionId)
      if (!found) {
        return toConversation(config, {
          originalSessionId: ref.originalSessionId,
          title: config.defaultTitle,
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          tasks: [],
          checkpoints: [],
          history: [],
          recordedEvents: [],
          losses: [],
        })
      }
      return attachTree(config, found, sessions)
    },
    async parseGraph(ref: SessionRef, input: SessionScanInput) {
      const sessions = await collectParsed(config, input)
      const found = sessions.find((session) => session.originalSessionId === ref.originalSessionId)
      const conversation = found
        ? attachTree(config, found, sessions)
        : await this.parseSession(ref, input)
      const graph = buildImportedSessionGraph(conversation, {
        sourceRuntime: config.id,
        sourceVersion: config.verifiedVersion,
        verifiedAt: "2026-08-29",
        importFidelity: config.fidelity ?? "structured",
      })
      const parsedById = new Map(
        sessions.map((session) => [
          importedSessionId(config.id, session.originalSessionId),
          session,
        ])
      )
      for (const node of graph.nodes) {
        const rich = parsedById.get(node.conversation.session.id)
        if (!rich) continue
        if (rich.tasks.length > 0) node.session.tasks = rich.tasks
        if (rich.checkpoints.length > 0) node.session.checkpoints = rich.checkpoints
        if (rich.history.length > 0) node.session.history = rich.history
        if (rich.recordedEvents.length > 0) node.session.recordedEvents = rich.recordedEvents
        node.loss.losses.push(...rich.losses)
      }
      return graph
    },
  }
}
