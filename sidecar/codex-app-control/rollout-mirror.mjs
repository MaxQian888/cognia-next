import { createReadStream } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { createInterface } from "node:readline"

function bounded(value, maxLength = 12_000) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n… [truncated]` : text
}

export function projectRolloutRecord(record) {
  const payload = record?.payload
  if (record?.type === "session_meta") {
    return {
      kind: "session",
      at: record.timestamp,
      threadId: payload?.session_id ?? payload?.id ?? null,
      cwd: payload?.cwd ?? null,
      originator: payload?.originator ?? null,
    }
  }
  if (record?.type === "event_msg" && payload?.type === "user_message") {
    return { kind: "message", at: record.timestamp, role: "user", text: bounded(payload.message) }
  }
  if (record?.type === "event_msg" && payload?.type === "agent_message") {
    return {
      kind: "message",
      at: record.timestamp,
      role: "assistant",
      phase: payload.phase ?? null,
      text: bounded(payload.message),
    }
  }
  if (record?.type === "event_msg" && payload?.type === "task_started") {
    return {
      kind: "turn",
      at: record.timestamp,
      status: "started",
      turnId: payload.turn_id ?? null,
    }
  }
  if (record?.type === "event_msg" && payload?.type === "task_complete") {
    return {
      kind: "turn",
      at: record.timestamp,
      status: "completed",
      turnId: payload.turn_id ?? null,
      lastAgentMessage: payload.last_agent_message ? bounded(payload.last_agent_message) : null,
    }
  }
  if (record?.type === "response_item" && payload?.type === "custom_tool_call") {
    return {
      kind: "tool",
      at: record.timestamp,
      status: payload.status ?? "started",
      name: payload.name ?? null,
      callId: payload.call_id ?? null,
      input: bounded(payload.input ?? ""),
    }
  }
  if (record?.type === "response_item" && payload?.type === "custom_tool_call_output") {
    return {
      kind: "tool",
      at: record.timestamp,
      status: "completed",
      callId: payload.call_id ?? null,
      output: bounded(payload.output ?? ""),
    }
  }
  return null
}

export function findNewTurnId(events, knownTurnIds) {
  return events
    .filter(
      (event) =>
        event.kind === "turn" &&
        event.status === "started" &&
        typeof event.turnId === "string" &&
        !knownTurnIds.has(event.turnId)
    )
    .at(-1)?.turnId
}

async function rolloutFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => `${entry.parentPath}/${entry.name}`)
}

export async function fileContainsMarker(path, marker) {
  let carry = ""
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    const combined = `${carry}${chunk}`
    if (combined.includes(marker)) return true
    carry = combined.slice(-Math.max(marker.length - 1, 0))
  }
  return false
}

export async function findRolloutByMarker(root, marker, { sinceMs = 0 } = {}) {
  const candidates = []
  for (const path of await rolloutFiles(root)) {
    const metadata = await stat(path)
    if (metadata.mtimeMs >= sinceMs) candidates.push({ path, mtimeMs: metadata.mtimeMs })
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  for (const candidate of candidates) {
    if (await fileContainsMarker(candidate.path, marker)) return candidate.path
  }
  return null
}

export async function findRolloutByThreadId(root, threadId) {
  const candidates = []
  for (const path of await rolloutFiles(root)) {
    const metadata = await stat(path)
    candidates.push({ path, mtimeMs: metadata.mtimeMs })
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  for (const candidate of candidates) {
    if (await fileContainsMarker(candidate.path, threadId)) return candidate.path
  }
  return null
}

export async function readProjectedRollout(path) {
  const events = []
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }) })
  for await (const line of lines) {
    try {
      const projected = projectRolloutRecord(JSON.parse(line))
      if (projected) events.push(projected)
    } catch {
      // A partially-written trailing line will be retried by the live tailer.
    }
  }
  return events
}
