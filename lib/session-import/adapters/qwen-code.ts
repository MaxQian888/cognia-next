import { joinPath } from "@/lib/claude/instructions/paths"

import { createPortableAgentSessionSource } from "./portable-agent-source"

type RecordValue = Record<string, unknown>
const object = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {}

/** Qwen's append-only transcript selects its last physical conversation UUID,
 * aggregates fragments, and walks parents; timestamps do not select the branch. */
function normalizeQwenDocument(document: unknown): unknown[] {
  const root = object(document)
  const raw = root.events ?? root.messages ?? (root.uuid ? [root] : undefined)
  if (
    !Array.isArray(raw) ||
    !raw.some((item) => {
      const value = object(item)
      return typeof value.uuid === "string" && typeof value.sessionId === "string"
    })
  )
    return [document]

  const groups = new Map<string, RecordValue[]>()
  for (const item of raw) {
    const value = object(item)
    const key = typeof value.sessionId === "string" ? value.sessionId : ""
    const group = groups.get(key)
    if (group) group.push(value)
    else groups.set(key, [value])
  }
  const documents: unknown[] = []
  for (const [sessionId, records] of groups) {
    const byUuid = new Map<string, RecordValue>()
    const artifacts: RecordValue[] = []
    const diagnostics: RecordValue[] = []
    let leaf = ""
    let title = root.title
    let parentSessionId = root.parentSessionId
    for (const value of records) {
      const payload = object(value.systemPayload)
      if (value.subtype === "custom_title" && typeof payload.customTitle === "string")
        title = payload.customTitle
      if (value.subtype === "parent_session")
        parentSessionId = payload.parentSessionId ?? parentSessionId
      if (
        value.subtype === "session_artifact_event" ||
        value.subtype === "session_artifact_snapshot"
      ) {
        artifacts.push(value)
        continue
      }
      if (
        typeof value.uuid !== "string" ||
        !value.uuid ||
        (value.parentUuid !== null && typeof value.parentUuid !== "string")
      ) {
        diagnostics.push({ type: "qwen.invalid_record", record: value })
        continue
      }
      leaf = value.uuid
      const existing = byUuid.get(leaf)
      if (!existing) {
        const message = object(value.message)
        byUuid.set(leaf, {
          ...value,
          message: { ...message, parts: Array.isArray(message.parts) ? [...message.parts] : [] },
        })
      } else {
        if (existing.parentUuid !== value.parentUuid) {
          diagnostics.push({ type: "qwen.conflicting_parent", uuid: leaf })
        }
        const previous = object(existing.message)
        const next = object(value.message)
        const combined = Array.isArray(previous.parts) ? previous.parts : []
        if (Array.isArray(next.parts)) for (const part of next.parts) combined.push(part)
        existing.message = { ...previous, parts: combined }
        if (value.usageMetadata) existing.usageMetadata = value.usageMetadata
        if (!existing.toolCallResult && value.toolCallResult)
          existing.toolCallResult = value.toolCallResult
        if (!existing.model && value.model) existing.model = value.model
        if (String(value.timestamp ?? "") > String(existing.timestamp ?? ""))
          existing.timestamp = value.timestamp
      }
    }
    const walk = (tail: string): RecordValue[] => {
      const chain: RecordValue[] = []
      const seen = new Set<string>()
      let current = tail
      while (current) {
        if (seen.has(current)) {
          chain.push({ type: "qwen.parent_cycle", uuid: current })
          break
        }
        seen.add(current)
        const value = byUuid.get(current)
        if (!value) {
          chain.push({ type: "qwen.history_gap", missingParentUuid: current })
          break
        }
        chain.push(value)
        current = typeof value.parentUuid === "string" ? value.parentUuid : ""
      }
      return chain.reverse()
    }
    const project = (chain: RecordValue[]): RecordValue[] =>
      chain.flatMap<RecordValue>((value) => {
        if (String(value.type).startsWith("qwen.")) return [{ ...value, role: "diagnostic" }]
        const message = object(value.message)
        const parts = Array.isArray(message.parts) ? message.parts : []
        const base = { ...value, id: value.uuid, usage: value.usageMetadata }
        if (value.type === "tool_result") {
          return parts.flatMap<RecordValue>((part) => {
            const response = object(object(part).functionResponse)
            if (!Object.keys(response).length)
              return [{ ...base, type: "qwen.unknown_tool_result", part }]
            const result = object(value.toolCallResult)
            return [
              {
                ...base,
                type: "tool_result",
                toolCallId: response.id ?? result.callId,
                output: Object.keys(result).length
                  ? { response: response.response, toolCallResult: result }
                  : response.response,
                isError: Boolean(object(response.response).error),
              },
            ]
          })
        }
        if (value.type === "user" || value.type === "assistant") {
          const unknownParts = parts.filter((part) => {
            const block = object(part)
            return !["text", "functionCall", "inlineData", "fileData"].some((key) => key in block)
          })
          return [
            { ...base, role: value.type, content: parts },
            ...unknownParts.map((part) => ({
              type: "qwen.unknown_part",
              timestamp: value.timestamp,
              part,
            })),
          ]
        }
        const payload = object(value.systemPayload)
        const type =
          value.subtype === "rewind"
            ? "rewind"
            : value.subtype === "chat_compression"
              ? "compaction"
              : value.subtype === "branch_checkpoint" || value.subtype === "file_history_snapshot"
                ? "checkpoint"
                : `qwen.${String(value.subtype ?? value.type)}`
        // Keep source metadata explicitly diagnostic even when a canonical history
        // marker exists; it cannot recreate native runtime/file checkpoint state.
        const diagnostic = {
          ...base,
          type: `qwen.${String(value.subtype ?? value.type)}`,
          role: "diagnostic",
          content: undefined,
        }
        return type.startsWith("qwen.")
          ? [diagnostic]
          : [{ ...base, type, summary: payload.summary ?? payload.description }, diagnostic]
      })
    const active = walk(leaf)
    const activeIds = new Set(active.map((value) => value.uuid))
    const parentIds = new Set([...byUuid.values()].map((value) => value.parentUuid))
    const first = records[0] ?? {}
    const fork = object(first.forkedFrom)
    const common = {
      ...root,
      events: undefined,
      cwd: first.cwd ?? root.cwd,
      createdAt: first.timestamp,
      title,
      parentSessionId: parentSessionId ?? fork.sessionId,
      kind: fork.sessionId ? "fork" : root.kind,
    }
    documents.push({
      ...common,
      sessionId,
      messages: project([...active, ...artifacts, ...diagnostics]),
    })
    for (const [uuid] of byUuid) {
      if (activeIds.has(uuid) || parentIds.has(uuid)) continue
      documents.push({
        ...common,
        sessionId: `${sessionId}:branch:${uuid}`,
        parentSessionId: sessionId,
        archiveOnly: true,
        kind: "branch",
        title: `Qwen Code branch ${uuid}`,
        messages: project(walk(uuid)),
      })
    }
  }
  return documents
}

/** Qwen Code official JSON/JSONL exports and local session-service artifacts. */
export const qwenCodeSessionSource = createPortableAgentSessionSource({
  id: "qwen-code",
  displayName: "Qwen Code",
  verifiedVersion: "0.16-alpha",
  presetId: "qwen-code",
  acceptedExtensions: [".json", ".jsonl"],
  roots: (home) =>
    home
      ? [
          joinPath(home, ".qwen/sessions"),
          joinPath(home, ".qwen/tmp"),
          joinPath(home, ".qwen/projects"),
        ]
      : [],
  pathHints: ["/.qwen/", "\\.qwen\\"],
  contentHints: ["qwen", "qwen-code"],
  defaultTitle: "Qwen Code session",
  normalizeDocument: normalizeQwenDocument,
  detectContent: (content) => {
    const isRecord = (value: unknown): boolean => {
      const row = object(value)
      return (
        typeof row.uuid === "string" &&
        typeof row.sessionId === "string" &&
        (typeof row.parentUuid === "string" || row.parentUuid === null) &&
        Array.isArray(object(row.message).parts)
      )
    }
    for (const fragment of [content, ...content.split("\n")]) {
      try {
        const parsed = JSON.parse(fragment) as unknown
        const root = object(parsed)
        const rows = root.events ?? root.messages ?? parsed
        if (Array.isArray(rows) ? rows.some(isRecord) : isRecord(rows)) return true
      } catch {
        /* A truncated preview cannot establish a structural match. */
      }
    }
    return false
  },
})
