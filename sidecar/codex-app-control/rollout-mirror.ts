import { createReadStream } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { createInterface } from "node:readline"

/**
 * One Codex rollout event, projected to what the controller exposes. Ids and
 * paths are passed through as the rollout wrote them (validated where used).
 */
export type RolloutEvent =
  | { kind: "session"; at: unknown; threadId: unknown; cwd: unknown; originator: unknown }
  | { kind: "message"; at: unknown; role: "user"; text: string }
  | { kind: "message"; at: unknown; role: "assistant"; phase: unknown; text: string }
  | { kind: "turn"; at: unknown; status: "started"; turnId: unknown }
  | {
      kind: "turn"
      at: unknown
      status: "completed"
      turnId: unknown
      lastAgentMessage: string | null
    }
  | { kind: "tool"; at: unknown; status: unknown; name: unknown; callId: unknown; input: string }
  | { kind: "tool"; at: unknown; status: "completed"; callId: unknown; output: string }

function bounded(value: unknown, maxLength = 12_000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n… [truncated]` : text
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export function projectRolloutRecord(record: unknown): RolloutEvent | null {
  if (!isRecord(record)) return null
  const payload = isRecord(record.payload) ? record.payload : {}
  const at = record.timestamp
  if (record.type === "session_meta") {
    return {
      kind: "session",
      at,
      threadId: payload.session_id ?? payload.id ?? null,
      cwd: payload.cwd ?? null,
      originator: payload.originator ?? null,
    }
  }
  if (record.type === "event_msg" && payload.type === "user_message") {
    return { kind: "message", at, role: "user", text: bounded(payload.message) }
  }
  if (record.type === "event_msg" && payload.type === "agent_message") {
    return {
      kind: "message",
      at,
      role: "assistant",
      phase: payload.phase ?? null,
      text: bounded(payload.message),
    }
  }
  if (record.type === "event_msg" && payload.type === "task_started") {
    return { kind: "turn", at, status: "started", turnId: payload.turn_id ?? null }
  }
  if (record.type === "event_msg" && payload.type === "task_complete") {
    return {
      kind: "turn",
      at,
      status: "completed",
      turnId: payload.turn_id ?? null,
      lastAgentMessage: payload.last_agent_message ? bounded(payload.last_agent_message) : null,
    }
  }
  if (record.type === "response_item" && payload.type === "custom_tool_call") {
    return {
      kind: "tool",
      at,
      status: payload.status ?? "started",
      name: payload.name ?? null,
      callId: payload.call_id ?? null,
      input: bounded(payload.input ?? ""),
    }
  }
  if (record.type === "response_item" && payload.type === "custom_tool_call_output") {
    return {
      kind: "tool",
      at,
      status: "completed",
      callId: payload.call_id ?? null,
      output: bounded(payload.output ?? ""),
    }
  }
  return null
}

export function findNewTurnId(
  events: readonly RolloutEvent[],
  knownTurnIds: ReadonlySet<unknown>
): string | undefined {
  return events
    .filter(
      (event): event is Extract<RolloutEvent, { kind: "turn" }> & { turnId: string } =>
        event.kind === "turn" &&
        event.status === "started" &&
        typeof event.turnId === "string" &&
        !knownTurnIds.has(event.turnId)
    )
    .at(-1)?.turnId
}

async function rolloutFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => `${entry.parentPath}/${entry.name}`)
}

export async function fileContainsMarker(path: string, marker: string): Promise<boolean> {
  let carry = ""
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    const combined = `${carry}${String(chunk)}`
    if (combined.includes(marker)) return true
    carry = combined.slice(-Math.max(marker.length - 1, 0))
  }
  return false
}

async function newestFirst(paths: readonly string[], sinceMs: number): Promise<string[]> {
  const candidates: Array<{ path: string; mtimeMs: number }> = []
  for (const path of paths) {
    const metadata = await stat(path)
    if (metadata.mtimeMs >= sinceMs) candidates.push({ path, mtimeMs: metadata.mtimeMs })
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates.map((candidate) => candidate.path)
}

export async function findRolloutByMarker(
  root: string,
  marker: string,
  { sinceMs = 0 }: { sinceMs?: number } = {}
): Promise<string | null> {
  for (const path of await newestFirst(await rolloutFiles(root), sinceMs)) {
    if (await fileContainsMarker(path, marker)) return path
  }
  return null
}

export async function findRolloutByThreadId(
  root: string,
  threadId: string
): Promise<string | null> {
  for (const path of await newestFirst(await rolloutFiles(root), Number.NEGATIVE_INFINITY)) {
    if (await fileContainsMarker(path, threadId)) return path
  }
  return null
}

export async function readProjectedRollout(path: string): Promise<RolloutEvent[]> {
  const events: RolloutEvent[] = []
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
