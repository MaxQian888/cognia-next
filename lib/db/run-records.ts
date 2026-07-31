/**
 * Durable per-turn Run Records — the persistence behind the Run Panel's
 * "second clock". One row per assistant turn (keyed `[sessionId+runId]`),
 * holding a slimmed, serializable snapshot of the turn's tools / sub-agents /
 * todos / timing so the panel survives scroll, refresh, and restart. A row with
 * no `settledAt` on reload is surfaced as "interrupted".
 *
 * Snapshots are written (debounced) by `hooks/chat/use-run-record-persistence`.
 */
import type { TodoEntry } from "@/lib/chat/todos"
import type { RunRecordStatus, RunRecordView } from "@/lib/claude/run-record"
import type { SubAgentStatus } from "@/types/agent/sub-agent"
import { getDb } from "./schema"

/** Serializable per-tool snapshot (the live `ToolUIPart` is never persisted). */
export interface RunRecordToolSnapshot {
  id: string
  toolName: string
  status: string
  startedAt?: number
  endedAt?: number
}

/** Serializable per-sub-agent snapshot. */
export interface RunRecordSubagentSnapshot {
  subagentId: string
  name: string
  status: SubAgentStatus
}

/** One persisted run. Primary key `[sessionId+runId]`. */
export interface RunRecordRow {
  sessionId: string
  runId: number
  /** Wall-clock turn start (epoch ms) — the sort key for "latest run". */
  startedAt: number
  /** Set when the run reached a terminal state; absent ⇒ interrupted on reload. */
  settledAt?: number
  status: RunRecordStatus
  tools: RunRecordToolSnapshot[]
  subagents: RunRecordSubagentSnapshot[]
  todos: TodoEntry[]
  todoCounts: { done: number; total: number }
  counts: { tools: number; subagents: number }
}

/** Terminal run statuses — these stamp `settledAt`. */
const TERMINAL_STATUSES: ReadonlySet<RunRecordStatus> = new Set(["done", "error", "interrupted"])

/**
 * Project the in-memory `RunRecordView` into a serializable row, or `null` when
 * the view has no `runId` (no turn has started). `settledAt` is stamped only for
 * a terminal status; `startedAt` falls back to `now` when the clock is idle.
 */
export function runRecordRowFromView(view: RunRecordView, now: number): RunRecordRow | null {
  if (view.runId == null) return null
  const terminal = TERMINAL_STATUSES.has(view.status)
  return {
    sessionId: view.sessionId,
    runId: view.runId,
    startedAt: view.timing.startedAt ?? now,
    ...(terminal ? { settledAt: now } : {}),
    status: view.status,
    tools: view.tools.map((t) => ({
      id: t.id,
      toolName: t.toolName,
      status: String(t.status ?? ""),
      ...(t.startedAt != null ? { startedAt: t.startedAt } : {}),
      ...(t.endedAt != null ? { endedAt: t.endedAt } : {}),
    })),
    subagents: view.subagentParts.map((p) => ({
      subagentId: p.subagentId,
      name: p.name,
      status: p.status,
    })),
    todos: view.todos,
    todoCounts: view.todoCounts,
    counts: view.counts,
  }
}

/** Insert or replace a run record (compound inbound key from the row). */
export async function upsertRunRecord(row: RunRecordRow): Promise<void> {
  await getDb().runRecords.put(row)
}

/** A session's run records, newest (highest `startedAt`) first. */
export async function listRunRecords(sessionId: string): Promise<RunRecordRow[]> {
  const rows = await getDb().runRecords.where("sessionId").equals(sessionId).toArray()
  return rows.sort((a, b) => b.startedAt - a.startedAt)
}

/** The most recent run record for a session, or undefined when none exist. */
export async function getLatestRunRecord(sessionId: string): Promise<RunRecordRow | undefined> {
  return (await listRunRecords(sessionId))[0]
}

/** Keep only the newest `keep` records for a session; delete the rest. */
export async function pruneRunRecords(sessionId: string, keep = 20): Promise<void> {
  const rows = await listRunRecords(sessionId)
  const stale = rows.slice(keep)
  if (stale.length === 0) return
  await getDb().runRecords.bulkDelete(stale.map((r) => [r.sessionId, r.runId] as [string, number]))
}

/** Delete every run record for a session (e.g. when the session is removed). */
export async function deleteRunRecordsForSession(sessionId: string): Promise<void> {
  await getDb().runRecords.where("sessionId").equals(sessionId).delete()
}
