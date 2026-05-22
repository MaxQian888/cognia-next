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
import { hasNoLeakingPii } from "@/lib/twin/ingest/redact"

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

  if (typeof input.value === "string" && !hasNoLeakingPii(input.value)) {
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
  return entry
}

/**
 * Delete a single entry. Fires `onSharedMemoryDelete` whether the entry
 * existed or not (the hook is purely informational).
 */
export function deleteEntry(teamId: string, key: string): void {
  useAgentTeamStore.getState().deleteSharedMemory(teamId, key)
  getPluginLifecycleHooks().dispatchOnSharedMemoryDelete({ teamId, key })
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

/** Drop every entry for a team. Convenience wrapper around the store action. */
export function clearTeamMemory(teamId: string): void {
  useAgentTeamStore.getState().clearTeamSharedMemory(teamId)
}
