/**
 * One-way write-through projection: agent-team-store → Dexie `agentTeamBoard`
 * (v104). The store stays the single write source; this module mirrors task +
 * team-meta rows so the companion sync pipeline can carry the board to the
 * phone. Dexie never writes back to the store — mobile edits travel as
 * Companion RPC commands, not data-level sync (team-board CQRS).
 *
 * DESKTOP-ONLY: install from the desktop sync-source provider (or its
 * headless twin). Installing on the mobile shell would wipe the synced mirror
 * with the phone's empty local store.
 *
 * Mechanics: a store subscription identity-diffs the `tasks`/`teams`/
 * `teammates` maps (the runtime writes through many actions — subscribing at
 * store level guarantees coverage), coalesces bursts into one microtask
 * flush, `bulkPut`s changed rows, and pairs every delete with a sync
 * tombstone so removals reach the phone.
 */

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { recordTombstones } from "@/lib/sync/tombstones"
import { loggers } from "@cognia/logging"
import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"
import {
  boardRowFromTask,
  boardRowFromTeam,
  deleteAgentTeamBoardRows,
  listAgentTeamBoardIds,
  putAgentTeamBoardRows,
  teamMetaRowId,
  type AgentTeamBoardRow,
} from "./agent-team-board"

const log = loggers.agent.child("team-board-projection")

interface Snapshot {
  tasks: Record<string, AgentTeamTask>
  teams: Record<string, AgentTeam>
  teammates: Record<string, AgentTeammate>
}

function takeSnapshot(): Snapshot {
  const state = useAgentTeamStore.getState()
  return { tasks: state.tasks, teams: state.teams, teammates: state.teammates }
}

/** Teams whose meta row is affected by a teammate-map change. */
function teamsOfChangedTeammates(prev: Snapshot, next: Snapshot): Set<string> {
  const affected = new Set<string>()
  for (const [id, mate] of Object.entries(next.teammates)) {
    if (prev.teammates[id] !== mate) affected.add(mate.teamId)
  }
  for (const [id, mate] of Object.entries(prev.teammates)) {
    if (!(id in next.teammates)) affected.add(mate.teamId)
  }
  return affected
}

/** Compute the incremental writes/deletes between two store snapshots. */
export function diffSnapshots(
  prev: Snapshot,
  next: Snapshot,
  updatedAt: number
): { puts: AgentTeamBoardRow[]; deletes: string[] } {
  const puts: AgentTeamBoardRow[] = []
  const deletes: string[] = []

  // Tasks: changed/new → put; removed → delete.
  for (const [id, task] of Object.entries(next.tasks)) {
    if (prev.tasks[id] !== task) puts.push(boardRowFromTask(task, updatedAt))
  }
  for (const id of Object.keys(prev.tasks)) {
    if (!(id in next.tasks)) deletes.push(id)
  }

  // Team-meta rows: refresh for changed teams + teams with roster changes.
  const metaDirty = teamsOfChangedTeammates(prev, next)
  for (const [id, team] of Object.entries(next.teams)) {
    if (prev.teams[id] !== team) metaDirty.add(id)
  }
  for (const teamId of metaDirty) {
    const team = next.teams[teamId]
    if (!team) continue // deleted below
    const roster = Object.values(next.teammates).filter((m) => m.teamId === teamId)
    puts.push(boardRowFromTeam(team, roster, updatedAt))
  }
  for (const id of Object.keys(prev.teams)) {
    if (!(id in next.teams)) deletes.push(teamMetaRowId(id))
  }

  return { puts, deletes }
}

/** Project the ENTIRE store and prune orphan rows (install-time reconcile). */
export async function reconcileAgentTeamProjection(now: number = Date.now()): Promise<void> {
  const snap = takeSnapshot()
  const rows: AgentTeamBoardRow[] = []
  for (const task of Object.values(snap.tasks)) rows.push(boardRowFromTask(task, now))
  for (const team of Object.values(snap.teams)) {
    const roster = Object.values(snap.teammates).filter((m) => m.teamId === team.id)
    rows.push(boardRowFromTeam(team, roster, now))
  }
  const desired = new Set(rows.map((r) => r.id))
  const existing = await listAgentTeamBoardIds()
  const orphans = existing.filter((id) => !desired.has(id))
  await putAgentTeamBoardRows(rows)
  await deleteAgentTeamBoardRows(orphans)
  await recordTombstones("agentTeamBoard", orphans, now)
}

/**
 * Install the write-through subscription. Returns an uninstaller. The initial
 * full reconcile also covers account switches — re-install after
 * `activateAgentTeamAccountStorage` swaps the persisted store.
 */
export function installAgentTeamProjection(): () => void {
  let prev = takeSnapshot()
  let flushScheduled = false
  let disposed = false

  const flush = async () => {
    flushScheduled = false
    if (disposed) return
    const next = takeSnapshot()
    const before = prev
    prev = next
    try {
      const { puts, deletes } = diffSnapshots(before, next, Date.now())
      await putAgentTeamBoardRows(puts)
      await deleteAgentTeamBoardRows(deletes)
      await recordTombstones("agentTeamBoard", deletes)
    } catch (err) {
      // Never let a projection failure break the store write that caused it;
      // the next reconcile heals the mirror.
      log.warn("agent-team board projection flush failed", { err: String(err) })
    }
  }

  const unsubscribe = useAgentTeamStore.subscribe((state) => {
    if (
      state.tasks === prev.tasks &&
      state.teams === prev.teams &&
      state.teammates === prev.teammates
    ) {
      return
    }
    if (flushScheduled) return
    flushScheduled = true
    queueMicrotask(() => void flush())
  })

  void reconcileAgentTeamProjection().catch((err) => {
    log.warn("agent-team board projection reconcile failed", { err: String(err) })
  })

  return () => {
    disposed = true
    unsubscribe()
  }
}
