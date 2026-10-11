/**
 * Host side of `memory_mutate`: a `/memory` console command sent by a paired
 * device, run against this host's store.
 *
 * The local console calls `manageMemory` directly; a paired device used to run
 * the same console against its synced mirror, so a pin, an edit or a delete on
 * a phone or on a browser paired to a headless host never reached the host and
 * was undone by the next pull. Routing the console here instead keeps one
 * implementation of every command (`manageMemory`) and adds only what a remote
 * principal needs on top of it:
 *
 *   - **Namespace authority.** The verified device's `principalGrants` may
 *     narrow which namespaces it can touch. Every row the command reads or
 *     writes — both sides of a conflict, the destination of a move, the
 *     namespace of a new row — must fall inside them. `clear` is narrowed to
 *     the rows the device may see instead of being refused, so "clear what I
 *     am looking at" means the same thing on every device.
 *   - **Idempotency.** The outbound queue retries a row until the host answers,
 *     so a command can arrive twice. An `operationId` reserves the
 *     `(principal, operation)` pair in the memory operation ledger; a replay of
 *     an applied command answers its first result instead of creating a second
 *     memory or deleting twice.
 *   - **Attribution.** A conflict resolution records the device as its actor.
 */

import type { TrustedMemoryCaller } from "@cognia/memory/types/caller"
import { memoryRowWithinNamespaces } from "@cognia/memory/types/caller"
import type { Memory } from "@/types/memory/memory"
import type { ManageMemoryCommand, ManageMemoryResult } from "@/lib/memory/control-plane/manage"
import { resolveMemoryCaller } from "./caller"

export interface ManageMemoryForCallerContext {
  /** Host-bound identity — `companionCaller(callerDeviceId)` for RPC. */
  caller: TrustedMemoryCaller
  /** Idempotency key, unique per principal (the queue row's operation id). */
  operationId?: string
}

/** `manageMemory`'s result — its failure set already names both remote refusals. */
export type ManageMemoryForCallerResult = ManageMemoryResult

type NamespaceRow = Pick<Memory, "scope" | "projectId" | "characterId" | "agentId">

/** The namespace a command would write a NEW row into, if it creates one. */
function createdNamespace(command: ManageMemoryCommand): NamespaceRow | undefined {
  if (command.kind === "create") {
    return {
      scope: command.scope ?? "global",
      projectId: command.projectId,
      characterId: command.characterId,
      agentId: command.agentId,
    }
  }
  if (command.kind === "relocate") {
    const target = command.target
    return {
      scope: target.scope,
      projectId: target.scope === "workspace" ? target.projectId : undefined,
      characterId: target.scope === "character" ? target.characterId : undefined,
      agentId: target.scope === "agent" ? target.agentId : undefined,
    }
  }
  return undefined
}

/** Ids of the existing rows a command reads or writes. */
function touchedIds(command: ManageMemoryCommand): string[] {
  switch (command.kind) {
    case "create":
    case "clear":
      return []
    case "resolve-conflict":
      return [command.keepId, command.dropId]
    case "invalidate":
      return command.supersededById ? [command.id, command.supersededById] : [command.id]
    default:
      return [command.id]
  }
}

export async function manageMemoryForCaller(
  command: ManageMemoryCommand,
  context: ManageMemoryForCallerContext
): Promise<ManageMemoryForCallerResult> {
  const [{ getSettings }, { resolveMemoryConfig }, memDb, { manageMemory }] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/types/memory/memory"),
    import("@/lib/db/memories"),
    import("@/lib/memory/control-plane/manage"),
  ])
  const settings = await getSettings().catch(() => undefined)
  const config = resolveMemoryConfig(settings?.memory)
  const caller = resolveMemoryCaller(context.caller, config)
  const namespaces = caller.namespaces

  // An unknown id is `not_found` from `manageMemory`, exactly as it is locally;
  // only rows that exist can be outside the caller's namespaces.
  for (const rowId of touchedIds(command)) {
    const row = await memDb.getMemory(rowId)
    if (row && !memoryRowWithinNamespaces(row, namespaces)) {
      return { ok: false, reason: "unauthorized_namespace" }
    }
  }
  const destination = createdNamespace(command)
  if (destination && !memoryRowWithinNamespaces(destination, namespaces)) {
    return { ok: false, reason: "unauthorized_namespace" }
  }

  const effective: ManageMemoryCommand =
    command.kind === "resolve-conflict" ? { ...command, actorId: caller.principalId } : command

  if (!context.operationId) return runCommand(effective)

  const ledger = await import("@/lib/db/memory-operations")
  const binding = {
    principalId: caller.principalId,
    operationId: context.operationId,
    requestHash: await ledger.memoryOperationRequestHash("manage", command),
    kind: "manage" as const,
  }
  let reservation = await ledger.reserveMemoryOperation(binding)
  if (reservation.state === "in_flight") {
    const settled = await ledger.awaitMemoryOperation(binding.principalId, binding.operationId)
    reservation = settled ? { state: "replay", receipt: settled } : reservation
  }
  if (reservation.state === "conflict") return { ok: false, reason: "idempotency_key_reused" }
  if (reservation.state === "replay") {
    return {
      ok: true,
      ...(reservation.receipt.memoryId ? { memoryId: reservation.receipt.memoryId } : {}),
    }
  }
  if (reservation.state === "in_flight") {
    // The first attempt is still applying (or died holding the key). Answering
    // with a retryable failure lets the queue try again instead of applying a
    // second copy of the same command.
    throw new Error("memory_mutate: operation still in flight")
  }

  let result: ManageMemoryForCallerResult
  try {
    result = await runCommand(effective)
  } catch (error) {
    await ledger.releaseMemoryOperation(
      binding.principalId,
      binding.operationId,
      binding.requestHash
    )
    throw error
  }
  if (!result.ok) {
    // A refused command changed nothing, so its key must free up for a
    // corrected retry (the same rule `runMemoryMutation` applies).
    await ledger.releaseMemoryOperation(
      binding.principalId,
      binding.operationId,
      binding.requestHash
    )
    return result
  }
  await ledger.recordMemoryOperation({
    id: `${binding.principalId}:${binding.operationId}`,
    principalId: binding.principalId,
    operationId: binding.operationId,
    kind: "manage",
    requestHash: binding.requestHash,
    memoryId: result.memoryId ?? "",
    resultCode: "ok",
    createdAt: Date.now(),
  })
  return result

  async function runCommand(next: ManageMemoryCommand): Promise<ManageMemoryForCallerResult> {
    if (next.kind !== "clear" || !namespaces) return manageMemory(next)
    // A restricted device clears only what it may see: one governed delete per
    // row, never the unscoped table-wide clear.
    const rows = await memDb.listMemories(
      next.query?.status === "invalidated" ? { ...next.query, includeRevisions: true } : next.query
    )
    const allowed = rows.filter((row) => memoryRowWithinNamespaces(row, namespaces))
    const allowedIds = new Set(allowed.map((row) => row.id))
    let clearedCount = 0
    const failedIds: string[] = []
    for (const row of allowed) {
      if (row.revisionOf && allowedIds.has(row.revisionOf)) continue
      const deleted = await manageMemory({ kind: "delete", id: row.id }).catch(() => undefined)
      if (deleted?.ok) clearedCount += 1
      else if (!deleted || deleted.reason !== "not_found") failedIds.push(row.id)
    }
    return failedIds.length
      ? { ok: false, reason: "partial_failure", clearedCount, failedIds }
      : { ok: true, clearedCount }
  }
}
