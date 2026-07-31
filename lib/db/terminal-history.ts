/**
 * CRUD for the `terminalHistory` table (schema v74, ADR-0039 phase 2).
 *
 * Durable, cross-session command history feeding the terminal autocomplete
 * history provider. The in-memory ring on `useTerminalStore` (50 entries,
 * lost on reload) stays the fast path; these rows make suggestions survive
 * restarts and work across tabs.
 *
 * One row per `(projectId, command)` pair — re-running a command bumps
 * `ts` + `uses` instead of inserting a duplicate, so frequency and recency
 * are both queryable. `projectId` is stored as `""` for project-less
 * sessions because IndexedDB compound keys cannot contain `null`.
 *
 * Privacy: the *caller* (spawn-orchestrator) gates writes behind the PII
 * check (`hasNoLeakingPii`) and the `terminal.autocomplete.persistHistory`
 * setting — nothing here re-checks, so keep this module behind that seam.
 */

import { getDb } from "./schema"

const MAX_ROWS = 5000
/** How many prefix matches to score before picking the top `limit`. */
const SCAN_CAP = 200

export interface TerminalHistoryRow {
  id: string
  /** The executed command line, trimmed. */
  command: string
  /** Owning project id, or `""` when the session had no project. */
  projectId: string
  /** Shell binary the command ran in (e.g. `pwsh.exe`, `/bin/zsh`). */
  shell: string
  /** Session cwd at command end, when known. */
  cwd: string | null
  /** Exit code from OSC 633 D, when the shell reported one. */
  exitCode: number | null
  /** Last execution time (ms epoch). */
  ts: number
  /** How many times this (projectId, command) pair has been recorded. */
  uses: number
  /** The session that most recently ran it. */
  sessionId: string
}

export interface RecordTerminalHistoryInput {
  command: string
  shell: string
  cwd: string | null
  exitCode: number | null
  sessionId: string
  projectId: string | null
  /** Test pin; defaults to `Date.now()`. */
  ts?: number
}

/**
 * Record one executed command. Re-running a command in the same project
 * bumps the existing row (`ts`, `uses`, latest cwd/exit) instead of adding
 * a duplicate. Empty / whitespace-only commands are ignored.
 */
export async function recordTerminalHistory(input: RecordTerminalHistoryInput): Promise<void> {
  const command = input.command.trim()
  if (!command) return
  const projectId = input.projectId ?? ""
  const ts = input.ts ?? Date.now()
  const db = getDb()
  const existing = await db.terminalHistory
    .where("[projectId+command]")
    .equals([projectId, command])
    .first()
  if (existing) {
    await db.terminalHistory.update(existing.id, {
      ts,
      uses: existing.uses + 1,
      cwd: input.cwd,
      exitCode: input.exitCode,
      sessionId: input.sessionId,
      shell: input.shell,
    })
    return
  }
  await db.terminalHistory.add({
    id: crypto.randomUUID(),
    command,
    projectId,
    shell: input.shell,
    cwd: input.cwd,
    exitCode: input.exitCode,
    ts,
    uses: 1,
    sessionId: input.sessionId,
  })
  await pruneTerminalHistory()
}

/** Drop the least-recently-used rows beyond `MAX_ROWS`. No-op under the cap. */
export async function pruneTerminalHistory(): Promise<void> {
  const table = getDb().terminalHistory
  const count = await table.count()
  if (count <= MAX_ROWS) return
  const excess = count - MAX_ROWS
  const oldest = await table.orderBy("ts").limit(excess).primaryKeys()
  await table.bulkDelete(oldest)
}

export interface QueryTerminalHistoryOptions {
  /** Case-insensitive command prefix; must be non-blank. */
  prefix: string
  /** Boosts rows recorded under the same project. */
  projectId?: string | null
  /** Boosts rows recorded in the same directory. */
  cwd?: string | null
  /** Max rows returned. Default 5. */
  limit?: number
  /** Test pin for the recency reference point; defaults to `Date.now()`. */
  now?: number
}

/**
 * Prefix-match the history, ranked by a blend of recency (exponential
 * decay, ~1-week half-life), frequency (`log1p(uses)`), and same-project /
 * same-cwd boosts. Exact-equal commands are excluded (nothing to complete).
 */
export async function queryTerminalHistory(
  opts: QueryTerminalHistoryOptions
): Promise<TerminalHistoryRow[]> {
  const prefix = opts.prefix
  if (!prefix || prefix.trim().length === 0) return []
  const now = opts.now ?? Date.now()
  const rows = await getDb()
    .terminalHistory.where("command")
    .startsWithIgnoreCase(prefix)
    .limit(SCAN_CAP)
    .toArray()

  const scored = rows
    .filter((r) => r.command.length > prefix.length)
    .map((r) => {
      const ageDays = Math.max(0, now - r.ts) / 86_400_000
      let score = Math.exp(-ageDays / 7) + 0.25 * Math.log1p(r.uses)
      if (opts.projectId && r.projectId === opts.projectId) score += 0.5
      if (opts.cwd && r.cwd === opts.cwd) score += 0.25
      return { row: r, score }
    })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, opts.limit ?? 5).map((s) => s.row)
}
