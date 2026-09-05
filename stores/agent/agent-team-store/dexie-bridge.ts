"use client"

/**
 * Bridges the in-memory Squad store with the Dexie definition tables.
 *
 * Dexie is AUTHORITATIVE for squads, teammates and tasks from persist v8 on.
 * Before it, all three lived in the `cognia-agent-teams` localStorage blob.
 * That made `AgentTeam.projectId` a filter three list surfaces applied rather
 * than a boundary anything enforced, it never reached a paired phone, and it
 * left the subsystem split down the middle: the RUNTIME half (`agentTeamRuns`
 * plus ten child tables) has been workspace-scoped in Dexie since v145.
 *
 * A mirror rather than a rewrite of the action layer. The store is 1,767 lines
 * of synchronous `set()` calls, and threading an await through every one of
 * them would be a large change with a lot of ways to drop a write. Subscribing
 * once and diffing cannot miss one.
 *
 * The two safety rules are the ones `lib/canvas/dexie-bridge.ts` and
 * `lib/artifacts/dexie-bridge.ts` already pay for:
 *
 *   1. **Never write to a database this mirror was not built against.**
 *      Locking an account clears the Dexie selection BEFORE it clears the
 *      store, so a live subscription would observe an empty store pointed at
 *      another account's database and delete every row in it.
 *   2. **A failed hydration disables the mirror entirely.** Deletes are derived
 *      from "in the mirror, absent from memory", and if hydration threw then
 *      memory is an unknown subset of the tables.
 *
 * Templates and `defaultConfig` are NOT mirrored here. Squad templates are
 * profile-shared by design, and the unified template platform owns them.
 */

import { loggers } from "@cognia/logging"

import {
  loadAgentTeamDefinitions,
  writeAgentTeamDefinitions,
} from "@/lib/db/agent-team-definitions"
import { getDb } from "@/lib/db/schema"
import {
  migrateSquadDefinition,
  type SquadBindingCandidates,
} from "@/lib/agent-team/definition-contract"
import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"
import { useAgentTeamStore } from "./store"

/**
 * How long a burst of writes may accumulate before it reaches Dexie. A running
 * squad emits progress on nearly every token, and none of that is worth a
 * transaction of its own.
 */
const SYNC_DEBOUNCE_MS = 400

const log = loggers.shell

interface Mirror {
  teams: Record<string, AgentTeam>
  teammates: Record<string, AgentTeammate>
  tasks: Record<string, AgentTeamTask>
}

let started = false
let mirror: Mirror = { teams: {}, teammates: {}, tasks: {} }
/** Which database {@link mirror} describes. See rule 1 in the header. */
let mirroredDbName: string | null = null
/** Rule 2: nothing is written until a hydration has actually succeeded. */
let hydrated = false
/**
 * Settles when the current bridge's hydration (and the definition migration
 * that follows it) is done. The Squad bootstrap orders itself on this:
 * recovery must not run over definitions that are still coming out of Dexie.
 */
let hydration: Promise<void> = Promise.resolve()
let resolveCandidates: BindingCandidateResolver | undefined

/**
 * Resolves the binding candidates for a workspace. Injected by the bootstrap
 * (it is an async Dexie + host read the bridge must not import eagerly) and
 * absent in tests that only exercise the mirror.
 */
export type BindingCandidateResolver = (
  projectId: string | undefined
) => Promise<SquadBindingCandidates>

export function setAgentTeamBindingCandidateResolver(
  resolver: BindingCandidateResolver | undefined
): void {
  resolveCandidates = resolver
}

/** The current bridge's hydration. Resolves at once when no bridge is running. */
export function whenAgentTeamDexieBridgeHydrated(): Promise<void> {
  return hydration
}

/** Diagnostics for the dev bridge and boot logs: which database the mirror is bound to. */
export function getAgentTeamDexieBridgeDiagnostics(): {
  started: boolean
  hydrated: boolean
  mirroredDbName: string | null
  mirroredTeamCount: number
} {
  return {
    started,
    hydrated,
    mirroredDbName,
    mirroredTeamCount: Object.keys(mirror.teams).length,
  }
}

/** Test-only: drop the module state so suites do not leak into each other. */
export function __resetAgentTeamDexieBridgeForTesting(): void {
  started = false
  mirror = { teams: {}, teammates: {}, tasks: {} }
  mirroredDbName = null
  hydrated = false
  hydration = Promise.resolve()
  resolveCandidates = undefined
}

function changedIds<T extends { id: string }>(
  next: Record<string, T>,
  previous: Record<string, T>
): { changed: T[]; removed: string[] } {
  const changed: T[] = []
  for (const [id, value] of Object.entries(next)) {
    // Identity, not deep equality. Every store action produces a new object for
    // what it touched and reuses the rest, so this is both correct and the
    // difference between one row and the whole table on a progress tick.
    if (previous[id] !== value) changed.push(value)
  }
  const removed = Object.keys(previous).filter((id) => !(id in next))
  return { changed, removed }
}

async function sync(next: Mirror): Promise<void> {
  if (!hydrated) return
  const dbName = getDb().name
  // Rule 1, see the module header.
  if (mirroredDbName !== null && mirroredDbName !== dbName) return
  mirroredDbName = dbName

  const teams = changedIds(next.teams, mirror.teams)
  const teammates = changedIds(next.teammates, mirror.teammates)
  const tasks = changedIds(next.tasks, mirror.tasks)
  if (
    teams.changed.length === 0 &&
    teams.removed.length === 0 &&
    teammates.changed.length === 0 &&
    teammates.removed.length === 0 &&
    tasks.changed.length === 0 &&
    tasks.removed.length === 0
  ) {
    return
  }

  await writeAgentTeamDefinitions({
    teams: teams.changed,
    teammates: teammates.changed,
    tasks: tasks.changed,
    deleteTeamIds: teams.removed,
    deleteTeammateIds: teammates.removed,
    deleteTaskIds: tasks.removed,
  })
  mirror = { teams: next.teams, teammates: next.teammates, tasks: next.tasks }
}

/**
 * Seed memory from Dexie for everything memory does not already hold.
 *
 * Memory wins a conflict. It is either what the user is looking at right now,
 * or the v7 localStorage blob that has not been migrated yet, and both are
 * newer than the row.
 */
async function hydrate(): Promise<void> {
  const stored = await loadAgentTeamDefinitions()
  const state = useAgentTeamStore.getState()

  const teamPatch: Record<string, AgentTeam> = {}
  for (const team of stored.teams) if (!state.teams[team.id]) teamPatch[team.id] = team
  const teammatePatch: Record<string, AgentTeammate> = {}
  for (const m of stored.teammates) if (!state.teammates[m.id]) teammatePatch[m.id] = m
  const taskPatch: Record<string, AgentTeamTask> = {}
  for (const task of stored.tasks) if (!state.tasks[task.id]) taskPatch[task.id] = task

  if (
    Object.keys(teamPatch).length > 0 ||
    Object.keys(teammatePatch).length > 0 ||
    Object.keys(taskPatch).length > 0
  ) {
    useAgentTeamStore.setState((current) => ({
      teams: { ...teamPatch, ...current.teams },
      teammates: { ...teammatePatch, ...current.teammates },
      tasks: { ...taskPatch, ...current.tasks },
    }))
  }

  // Prime the mirror with exactly what was seeded, so the first sync does not
  // write back the rows it just read. What was already in memory is
  // deliberately NOT primed: memory won, so the row on disk is stale and the
  // first sync has to overwrite it. That is also how the v7 blob migrates.
  mirror = { teams: teamPatch, teammates: teammatePatch, tasks: taskPatch }
  mirroredDbName = getDb().name
  hydrated = true

  await migrateHydratedDefinitions()
}

/**
 * Bring every definition in memory onto the current contract (ADR-0169).
 *
 * Runs after hydration and before the subscription, so a changed team differs
 * from the primed mirror and the first sync writes it down. Idempotent: on a
 * boot where nothing changes it touches nothing. Candidates are resolved once
 * per workspace, never per team, and only when a team is missing a binding.
 */
export async function migrateHydratedDefinitions(): Promise<number> {
  const state = useAgentTeamStore.getState()
  const teams = Object.values(state.teams)
  const candidateCache = new Map<string, Promise<SquadBindingCandidates>>()
  const candidatesFor = (projectId: string | undefined): Promise<SquadBindingCandidates> => {
    if (!resolveCandidates) return Promise.resolve({})
    const key = projectId ?? ""
    let pending = candidateCache.get(key)
    if (!pending) {
      pending = resolveCandidates(projectId).catch(() => ({}))
      candidateCache.set(key, pending)
    }
    return pending
  }
  let changed = 0
  const next: Record<string, AgentTeam> = {}
  for (const team of teams) {
    const needsCandidates =
      !team.config.repositories?.some((r) => r.role === "primary") || !team.config.environmentRef
    const candidates = needsCandidates ? await candidatesFor(team.projectId) : {}
    const result = migrateSquadDefinition(team, candidates)
    if (result.changed) {
      next[team.id] = result.team
      changed += 1
    }
  }
  if (changed > 0) {
    useAgentTeamStore.setState((current) => ({ teams: { ...current.teams, ...next } }))
  }
  return changed
}

/**
 * Start the bridge. Idempotent. Returns a disposer for callers that want to
 * scope it to a lifecycle.
 *
 * Boot order: hydrate Dexie into memory FIRST, then subscribe. Subscribing
 * first would let hydration's own `setState` race the mirror and clobber rows
 * it had not yet observed.
 */
export function startAgentTeamDexieBridge(): () => void {
  if (started || typeof window === "undefined") return () => {}
  started = true

  let disposed = false
  let unsubscribe: () => void = () => {}
  let pending: ReturnType<typeof setTimeout> | null = null
  let queued: Mirror | null = null

  const flush = () => {
    pending = null
    const next = queued
    queued = null
    if (!next) return
    void sync(next).catch((err) =>
      log.warn("agent-team dexie-bridge sync failed", { err: String(err) })
    )
  }

  hydration = hydrate().catch((err) => {
    log.warn("agent-team dexie-bridge hydration failed", { err: String(err) })
    throw err
  })
  void hydration
    .then(() => {
      if (disposed) return
      const initial = useAgentTeamStore.getState()
      // Whatever hydration did not seed reaches Dexie here, which on the first
      // boot after persist v8 is everything still coming out of the old blob.
      void sync({
        teams: initial.teams,
        teammates: initial.teammates,
        tasks: initial.tasks,
      }).catch((err) =>
        log.warn("agent-team dexie-bridge initial sync failed", { err: String(err) })
      )

      unsubscribe = useAgentTeamStore.subscribe((state) => {
        // The subscription is unselected, so it fires on every store write
        // including the ones that only touch UI state. Bail on identity before
        // scheduling any work.
        if (
          state.teams === mirror.teams &&
          state.teammates === mirror.teammates &&
          state.tasks === mirror.tasks
        ) {
          return
        }
        queued = { teams: state.teams, teammates: state.teammates, tasks: state.tasks }
        if (pending) return
        pending = setTimeout(flush, SYNC_DEBOUNCE_MS)
      })
    })
    .catch((err) => {
      // Rule 2. `hydrated` stays false, so nothing is ever written and no row
      // is deleted on the strength of a memory image we cannot trust.
      log.warn("agent-team dexie-bridge hydration failed; mirror disabled", {
        err: String(err),
      })
    })

  return () => {
    disposed = true
    if (pending) clearTimeout(pending)
    unsubscribe()
    started = false
  }
}
