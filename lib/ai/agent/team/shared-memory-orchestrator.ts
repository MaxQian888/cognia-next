/**
 * Shared-memory orchestrator — thin business logic on top of the store's
 * `writeSharedMemory` / `deleteSharedMemory` / `clearTeamSharedMemory`
 * actions.
 *
 * Adds:
 *   - `publishEntry`: builds a `SharedMemoryEntry` (id + version + writtenAt),
 *     **enforces the PII gate** via `lib/twin/ingest/redact.ts:hasNoLeakingPii`
 *     when the value is a string, and only then writes through to the store.
 *     Fires `onSharedMemoryWrite`.
 *   - `deleteEntry`: store delete + fires `onSharedMemoryDelete`.
 *   - `autoPublishTaskResult`: convenience helper the dispatch executor calls
 *     after a teammate completes a task — keys the entry as
 *     `task:<taskId>` and tags it with the writer + task title for the
 *     workspace's Shared Memory UI.
 *
 * The PII gate is non-negotiable for string values (per [[feedback_reuse_existing_components]]).
 * Object values bypass the gate today — callers must explicitly serialise
 * to a vetted JSON before publishing if they want the same guarantee.
 */

import type {
  AgentTeam,
  AgentTeamTask,
  AgentTeammate,
  SharedMemoryEntry,
} from "@/types/agent/agent-team"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { getPluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"
import { hasNoLeakingPii, hasNoLeakingPiiDeep } from "@cognia/redact"
import { getSharedMemoryAdapter } from "@/lib/plugin/registries/shared-memory-adapter-registry"
import { loggers } from "@cognia/logging"

// Re-exported so build-options and other consumers share one ACL predicate.
export {
  OPERATOR_READER_ID,
  isEntryReadableBy,
  selectSharedMemoryEntriesForReader,
} from "@/stores/agent/agent-team-store/selectors"

export interface PublishEntryInput {
  teamId: string
  key: string
  value: unknown
  /** Teammate writing this entry. Used for `writtenBy` + display name. */
  writer: Pick<AgentTeammate, "id" | "name">
  /** Optional expiration timestamp (ms since epoch). */
  expiresAt?: Date
  /** Optional tags for filtering in the workspace Memory section. */
  tags?: string[]
  /** Access-control allow-list (teammate ids that may read). Empty = all. */
  readableBy?: string[]
}

export class SharedMemoryPiiError extends Error {
  constructor(public readonly key: string) {
    super(`SharedMemory write blocked: PII detected in value for key="${key}"`)
    this.name = "SharedMemoryPiiError"
  }
}

/**
 * Publish a single shared-memory entry. String values are passed through
 * `hasNoLeakingPii`; if any PII signal fires the entry is rejected with a
 * `SharedMemoryPiiError` and the store is left untouched.
 *
 * Versioning: when an entry already exists at `key`, the new entry's
 * `version` is `existing.version + 1`; first write is `version: 1`.
 */
export function publishEntry(input: PublishEntryInput): SharedMemoryEntry {
  const store = useAgentTeamStore.getState()
  const teamMemory = store.sharedMemory[input.teamId] ?? {}
  const existing = teamMemory[input.key]

  // Deep PII gate: scans every string leaf of strings, arrays, and plain
  // objects so object-shaped values can no longer smuggle PII past the gate.
  if (!hasNoLeakingPiiDeep(input.value)) {
    throw new SharedMemoryPiiError(input.key)
  }

  const entry: SharedMemoryEntry = {
    key: input.key,
    value: input.value,
    writtenBy: input.writer.id,
    writerName: input.writer.name,
    writtenAt: new Date(),
    expiresAt: input.expiresAt,
    version: (existing?.version ?? 0) + 1,
    tags: input.tags,
    readableBy: input.readableBy,
  }
  store.writeSharedMemory(input.teamId, input.key, entry)
  getPluginLifecycleHooks().dispatchOnSharedMemoryWrite({
    teamId: input.teamId,
    key: input.key,
    writerId: input.writer.id,
  })
  mirrorWriteToAdapter(input.teamId, entry)
  return entry
}

/**
 * Mirror a write to the team's configured shared-memory adapter, if any.
 * Fire-and-forget: a failed mirror logs but never blocks the local write
 * (per the per-plugin isolation pattern). Skips entries that arrived *from*
 * the adapter (provenance-tagged via `:sync`) to avoid an echo loop.
 */
function mirrorWriteToAdapter(teamId: string, entry: SharedMemoryEntry): void {
  const adapterId = useAgentTeamStore.getState().teams[teamId]?.config.sharedMemoryAdapterId
  if (!adapterId) return
  if (typeof entry.writerName === "string" && entry.writerName.endsWith(":sync")) return
  const adapter = getSharedMemoryAdapter(adapterId)
  if (!adapter) return
  queueMicrotask(() => {
    adapter.write(teamId, entry).catch((err) => {
      loggers.agent.warn(`SharedMemoryAdapter ${adapterId} write failed:`, err)
    })
  })
}

/**
 * Delete a single entry. Fires `onSharedMemoryDelete` whether the entry
 * existed or not (the hook is purely informational).
 */
export function deleteEntry(teamId: string, key: string): void {
  useAgentTeamStore.getState().deleteSharedMemory(teamId, key)
  getPluginLifecycleHooks().dispatchOnSharedMemoryDelete({ teamId, key })
  const adapterId = useAgentTeamStore.getState().teams[teamId]?.config.sharedMemoryAdapterId
  if (adapterId) {
    const adapter = getSharedMemoryAdapter(adapterId)
    if (adapter) {
      queueMicrotask(() => {
        adapter.delete(teamId, key).catch((err) => {
          loggers.agent.warn(`SharedMemoryAdapter ${adapterId} delete failed:`, err)
        })
      })
    }
  }
}

/**
 * Convenience helper for the task-dispatch executor: after a teammate
 * successfully completes a task, publish the result under the canonical
 * `task:<taskId>` key. Falls through silently when the result string is
 * empty or contains PII (returns undefined). Logging is the caller's
 * responsibility — keeping this function pure makes it easy to mock in
 * the dispatch executor tests.
 */
export function autoPublishTaskResult(
  team: Pick<AgentTeam, "id">,
  task: Pick<AgentTeamTask, "id" | "title">,
  result: string,
  writer: Pick<AgentTeammate, "id" | "name">
): SharedMemoryEntry | undefined {
  const trimmed = result.trim()
  if (trimmed.length === 0) return undefined
  if (!hasNoLeakingPii(trimmed)) return undefined
  return publishEntry({
    teamId: team.id,
    key: `task:${task.id}`,
    value: trimmed,
    writer,
    tags: [`task:${task.id}`, `taskTitle:${task.title}`],
  })
}

/** One upstream dependency's result, read back off the blackboard. */
export interface DependencyResult {
  taskId: string
  /** Recovered from the `taskTitle:<title>` tag stamped by `autoPublishTaskResult`. */
  taskTitle?: string
  writerName?: string
  value: string
}

/**
 * Read the blackboard results published by {@link autoPublishTaskResult} for
 * the given dependency task ids. Keeps the `task:<id>` key convention
 * co-located with the writer so the format lives in exactly one module.
 *
 * Skips ids with no entry or a non-string value, and preserves the input
 * order. Used by the `action.team.task.dispatch` executor to inject upstream
 * results into a teammate's prompt so the team builds on prior work instead of
 * each teammate starting cold.
 */
export function readDependencyResults(
  teamId: string,
  depTaskIds: readonly string[]
): DependencyResult[] {
  if (depTaskIds.length === 0) return []
  const teamMemory = useAgentTeamStore.getState().sharedMemory[teamId] ?? {}
  const out: DependencyResult[] = []
  for (const depId of depTaskIds) {
    const entry = teamMemory[`task:${depId}`]
    if (!entry || typeof entry.value !== "string") continue
    const titleTag = entry.tags?.find((t) => t.startsWith("taskTitle:"))
    out.push({
      taskId: depId,
      ...(titleTag ? { taskTitle: titleTag.slice("taskTitle:".length) } : {}),
      ...(entry.writerName ? { writerName: entry.writerName } : {}),
      value: entry.value,
    })
  }
  return out
}

/** Drop every entry for a team. Convenience wrapper around the store action. */
export function clearTeamMemory(teamId: string): void {
  useAgentTeamStore.getState().clearTeamSharedMemory(teamId)
}

/**
 * Reverse mirror: pull changes from the team's configured shared-memory
 * adapter and write back any entry the local store is missing or holds an
 * older version of. Conflict resolution is local-version-wins. Pulled entries
 * are provenance-tagged (`writerName: "<adapterId>:sync"`) and DO NOT re-fire
 * the `onSharedMemoryWrite` hook or re-mirror (the `:sync` guard in
 * `mirrorWriteToAdapter` prevents the echo). Advances the persisted cursor.
 *
 * Returns `{ pulled }` — the number of entries written back. A no-op (returns
 * `{ pulled: 0 }`) when the team has no adapter configured.
 */
export async function syncSharedMemoryFromAdapter(teamId: string): Promise<{ pulled: number }> {
  const store = useAgentTeamStore.getState()
  const adapterId = store.teams[teamId]?.config.sharedMemoryAdapterId
  if (!adapterId) return { pulled: 0 }
  const adapter = getSharedMemoryAdapter(adapterId)
  if (!adapter) return { pulled: 0 }

  const since = store.lastAdapterSyncVersion[teamId]?.[adapterId]
  const { entries, cursor } = await adapter.listChanges(teamId, since)

  let pulled = 0
  for (const remote of entries) {
    const local = useAgentTeamStore.getState().sharedMemory[teamId]?.[remote.key]
    if (local && local.version >= remote.version) continue // local wins
    useAgentTeamStore.getState().writeSharedMemory(teamId, remote.key, {
      ...remote,
      writerName: `${adapterId}:sync`,
    })
    pulled += 1
  }

  useAgentTeamStore.getState().setAdapterSyncVersion(teamId, adapterId, cursor)
  return { pulled }
}
