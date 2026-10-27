/** Durable ADR-0213 bridge. Contains identities only; no screenshots or result text. */
import type { ChatSession } from "@cognia/agent-config-types"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"
import type { SessionPersistenceScope } from "@/lib/db/sessions"
import type { CogniaDB } from "@/lib/db/schema"
import { getDb } from "@/lib/db/schema"
import { getActiveRemoteEndpoint, getActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import { localTransport, transport, onTransportChange } from "@/lib/tauri/transport-instance"
import { useAccountStore } from "@/stores/account/account-store"
import { isTauri } from "@/lib/utils"
import { isHeadlessHost } from "@/lib/platform/detect"

type SourceHost = NonNullable<ChatSession["deliverySourceHosts"]>[number]
type GatewayLink = NonNullable<ChatSession["externalAgentSession"]>
export const MANAGED_DESKTOP_RUN_PREFIX = "execution:managed-desktop:"
export interface ManagedDesktopDeletionRow {
  id: string
  ownerAccountId: string
  host: SourceHost
  conversationIds: string[]
  taskIds: string[]
  acceptanceIds: string[]
  /** Legacy journal field; never used as cleanup authority. */
  gatewayLinks?: Pick<GatewayLink, "agentId" | "sessionId">[]
  phase: "preparing" | "committed" | "deleted"
  createdAt: number
  updatedAt: number
  attempts: number
}
interface DeletionReceipt {
  operationId: string
  state: "prepared" | "committed" | "aborted"
  cleanupPending: boolean
  /** Derived by this Host from durable source ownership, never from renderer links. */
  taskIds: string[]
}

// A sweeper must not abort an intent whose database transaction is still live.
let tail: Promise<void> = Promise.resolve()
async function acquire(): Promise<() => void> {
  const previous = tail
  let release!: () => void
  tail = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  // Cross-window coordination complements the in-process queue. A second
  // renderer must not treat another window's live prepare as a crashed one.
  if (typeof navigator !== "undefined" && navigator.locks) {
    const releaseLocal = release
    let unlock!: () => void
    const hold = new Promise<void>((resolve) => {
      unlock = resolve
    })
    await new Promise<void>((resolve, reject) => {
      void navigator.locks
        .request(`cognia:desktop-deletion:${getDb().name}`, async () => {
          release = () => {
            unlock()
            releaseLocal()
          }
          resolve()
          await hold
        })
        .catch((error) => {
          releaseLocal()
          reject(error)
        })
    })
  }
  return release
}
function announce(rows: readonly ManagedDesktopDeletionRow[]): void {
  if (typeof window === "undefined" || rows.length === 0) return
  window.dispatchEvent(
    new CustomEvent("cognia:managed-desktop-results-deleted", {
      detail: {
        conversationIds: [...new Set(rows.flatMap((row) => row.conversationIds))],
        taskIds: [...new Set(rows.flatMap((row) => row.taskIds))],
        acceptanceIds: [...new Set(rows.flatMap((row) => row.acceptanceIds))],
      },
    })
  )
}
function identityGuard(db: CogniaDB, owner: string, assertPersistence: () => void) {
  let invalidated = false
  const check = () => {
    const account = useAccountStore.getState()
    if (account.locked || account.unlockedAccountId !== owner || getDb() !== db) invalidated = true
  }
  const detach = useAccountStore.subscribe(check)
  return {
    assert() {
      assertPersistence()
      check()
      if (invalidated) throw new Error("managed_desktop_deletion_identity_changed")
    },
    detach,
  }
}
async function call<T>(
  row: ManagedDesktopDeletionRow,
  name: string,
  args: Record<string, unknown>,
  assertActive: () => void
): Promise<T> {
  const remote = getActiveRemoteTransport()
  const endpoint = getActiveRemoteEndpoint()
  const local = isTauri() ? localTransport : transport
  const endpointIdentity = endpoint
    ? JSON.stringify([
        endpoint.baseUrl,
        endpoint.serverFingerprint,
        endpoint.deviceId,
        endpoint.deviceKeyThumbprint,
      ])
    : undefined
  if (
    (remote ? "remote" : "local") !== row.host.kind ||
    (remote && endpointIdentity !== row.host.endpointIdentity) ||
    (!remote && !isTauri() && !isHeadlessHost())
  )
    throw new Error("managed_desktop_deletion_original_host_required")
  let invalidated = false
  const detach = onTransportChange(() => {
    invalidated = true
  })
  const callHost = <R>(command: string, input: Record<string, unknown>) =>
    remote
      ? remote.call<R>(command, input)
      : isTauri() && command.startsWith("managed_desktop_")
        ? local.call<R>("managed_desktop_local_call", { name: command, args: input })
        : local.call<R>(command, input)
  const check = () => {
    assertActive()
    const current = getActiveRemoteEndpoint()
    const currentIdentity = current
      ? JSON.stringify([
          current.baseUrl,
          current.serverFingerprint,
          current.deviceId,
          current.deviceKeyThumbprint,
        ])
      : undefined
    if (
      invalidated ||
      getActiveRemoteTransport() !== remote ||
      (remote && currentIdentity !== endpointIdentity) ||
      (!remote && !isTauri() && transport !== local)
    )
      throw new Error("managed_desktop_deletion_host_changed")
  }
  try {
    check()
    const identity = await callHost<{ hostId: string }>("managed_desktop_handoff_source_host", {})
    check()
    if (identity.hostId !== row.host.hostId)
      throw new Error("managed_desktop_deletion_original_host_required")
    const result = await callHost<T>(name, args)
    check()
    return result
  } finally {
    detach()
  }
}
async function prepare(row: ManagedDesktopDeletionRow, assertActive: () => void): Promise<void> {
  const receipt = await call<DeletionReceipt>(
    row,
    "managed_desktop_results_prepare_delete",
    {
      operationId: row.id,
      conversationIds: row.conversationIds,
      taskIds: row.conversationIds.length ? [] : row.taskIds,
      acceptanceIds: row.conversationIds.length ? [] : row.acceptanceIds,
    },
    assertActive
  )
  if (receipt.operationId !== row.id || !["prepared", "committed"].includes(receipt.state))
    throw new Error("managed_desktop_deletion_acknowledgment_required")
}
async function replayRow(
  db: CogniaDB,
  row: ManagedDesktopDeletionRow,
  assertActive: () => void
): Promise<boolean> {
  try {
    assertActive()
    if (row.phase === "deleted") return false
    if (row.phase === "preparing") {
      const receipt = await call<DeletionReceipt>(
        row,
        "managed_desktop_results_abort_delete",
        { operationId: row.id },
        assertActive
      )
      if (receipt.operationId !== row.id || receipt.state !== "aborted")
        throw new Error("managed_desktop_deletion_acknowledgment_required")
    } else {
      await prepare(row, assertActive)
      const receipt = await call<DeletionReceipt>(
        row,
        "managed_desktop_results_commit_delete",
        { operationId: row.id },
        assertActive
      )
      if (
        receipt.operationId !== row.id ||
        receipt.state !== "committed" ||
        typeof receipt.cleanupPending !== "boolean"
      )
        throw new Error("managed_desktop_deletion_cleanup_pending")
      let finalReceipt = receipt
      if (row.conversationIds.length) {
        await call(
          row,
          "managed_desktop_handoff_revoke_source",
          { conversationIds: row.conversationIds },
          assertActive
        )
        // Revocation closes the admission window. A fresh receipt now includes
        // every task admitted before that fence, scoped to this exact Host.
        finalReceipt = await call<DeletionReceipt>(
          row,
          "managed_desktop_results_commit_delete",
          { operationId: row.id },
          assertActive
        )
      }
      if (
        finalReceipt.operationId !== row.id ||
        finalReceipt.state !== "committed" ||
        typeof finalReceipt.cleanupPending !== "boolean" ||
        !Array.isArray(finalReceipt.taskIds) ||
        !finalReceipt.taskIds.every(
          (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id)
        ) ||
        (!row.conversationIds.length && !row.taskIds.length && finalReceipt.taskIds.length)
      )
        throw new Error("managed_desktop_deletion_acknowledgment_required")
      for (const taskId of new Set(finalReceipt.taskIds)) {
        await call(row, "external_agent_delete_gateway_task", { taskId }, assertActive)
      }
      if (finalReceipt.cleanupPending) throw new Error("managed_desktop_deletion_cleanup_pending")
    }
    assertActive()
    if (row.phase === "committed" && row.conversationIds.length === 0) {
      // An acceptance may be deleted while its source conversation survives.
      // Keep its non-content fence so an in-flight old Host result cannot reimport it.
      await db.managedDesktopDeletionOutbox.update(row.id, {
        phase: "deleted",
        updatedAt: Date.now(),
      })
    } else await db.managedDesktopDeletionOutbox.delete(row.id)
    return true
  } catch {
    // No backend messages, paths or evidence contents enter the durable queue.
    assertActive()
    await db.managedDesktopDeletionOutbox.update(row.id, {
      attempts: row.attempts + 1,
      updatedAt: Date.now(),
    })
    return false
  }
}

export async function listPendingManagedDesktopResultDeletions(): Promise<
  ManagedDesktopDeletionRow[]
> {
  const db = getDb()
  const account = useAccountStore.getState()
  if (account.locked || !account.unlockedAccountId) return []
  const guard = identityGuard(db, account.unlockedAccountId, () => undefined)
  try {
    const rows = await db.managedDesktopDeletionOutbox
      .where("ownerAccountId")
      .equals(account.unlockedAccountId)
      .filter((row) => row.phase !== "deleted")
      .toArray()
    guard.assert()
    return rows
  } finally {
    guard.detach()
  }
}
export async function isManagedDesktopResultDeletionPending(
  db: CogniaDB,
  scope: { conversationId?: string; taskId?: string; acceptanceId?: string }
): Promise<boolean> {
  return (
    (await db.managedDesktopDeletionOutbox
      .filter(
        (row) =>
          (!!scope.conversationId && row.conversationIds.includes(scope.conversationId)) ||
          (!!scope.taskId && row.taskIds.includes(scope.taskId)) ||
          (!!scope.acceptanceId && row.acceptanceIds.includes(scope.acceptanceId))
      )
      .count()) > 0
  )
}
export async function retryManagedDesktopResultDeletions(report?: {
  blocked: number
  failed: number
}): Promise<number> {
  const release = await acquire()
  const db = getDb()
  const account = useAccountStore.getState()
  if (account.locked || !account.unlockedAccountId) {
    if (report) report.blocked++
    release()
    return 0
  }
  const guard = identityGuard(db, account.unlockedAccountId, () => undefined)
  try {
    const rows = await db.managedDesktopDeletionOutbox
      .where("ownerAccountId")
      .equals(account.unlockedAccountId)
      .filter((row) => row.phase !== "deleted")
      .toArray()
    let removed = 0
    for (const row of rows) {
      if (await replayRow(db, row, guard.assert)) removed++
      else if (report) report.failed++
    }
    return removed
  } finally {
    guard.detach()
    release()
  }
}

/** Called after canonical delete guards; caller must include outbox in its delete transaction. */
export async function prepareManagedDesktopSessionDeletion(
  db: CogniaDB,
  sessions: readonly (ChatSession | undefined)[],
  assertPersistence: () => void = () => undefined
) {
  const release = await acquire()
  const sources = sessions.filter((row): row is ChatSession => !!row?.deliverySourceHosts?.length)
  const owner = useAccountStore.getState().unlockedAccountId
  if (sources.length && !owner) {
    release()
    throw new Error("managed_desktop_authentication_required")
  }
  const guard = identityGuard(db, owner ?? "", assertPersistence)
  const rows: ManagedDesktopDeletionRow[] = []
  try {
    for (const session of sources) {
      guard.assert()
      const runs = await db.executionRuns.where("sessionId").equals(session.id).toArray()
      const acceptanceIds = runs
        .filter((run) => run.id.startsWith(MANAGED_DESKTOP_RUN_PREFIX))
        .map((run) => run.id.slice(MANAGED_DESKTOP_RUN_PREFIX.length))
      for (const host of session.deliverySourceHosts ?? []) {
        const now = Date.now()
        const row: ManagedDesktopDeletionRow = {
          id: crypto.randomUUID(),
          ownerAccountId: owner!,
          host,
          conversationIds: [session.id],
          taskIds: [],
          acceptanceIds,
          phase: "preparing",
          createdAt: now,
          updatedAt: now,
          attempts: 0,
        }
        await db.managedDesktopDeletionOutbox.add(row)
        rows.push(row)
        announce([row])
        try {
          await prepare(row, guard.assert)
        } catch {
          guard.assert() /* Offline: replay after commit. */
        }
      }
    }
    return {
      async commitInsideTransaction(deletedIds: readonly string[]) {
        const current = await db.sessions.bulkGet([...deletedIds])
        for (const session of current) {
          if (!session?.deliverySourceHosts?.length) continue
          const original = sources.find((source) => source.id === session.id)
          if (
            !original ||
            JSON.stringify(original.deliverySourceHosts) !==
              JSON.stringify(session.deliverySourceHosts)
          )
            throw new Error("managed_desktop_deletion_scope_changed")
        }
        for (const row of rows) {
          guard.assert()
          if (!row.conversationIds.every((id) => deletedIds.includes(id)))
            throw new Error("managed_desktop_deletion_scope_changed")
          await db.managedDesktopDeletionOutbox.update(row.id, {
            phase: "committed",
            updatedAt: Date.now(),
          })
          row.phase = "committed"
        }
      },
      async finish(committed: boolean) {
        try {
          if (committed) announce(rows)
          for (const row of rows) {
            // In-memory phase changes roll back with the failed database transaction.
            if (!committed) row.phase = "preparing"
            await replayRow(db, row, guard.assert)
          }
        } finally {
          guard.detach()
          release()
        }
      },
    }
  } catch (error) {
    try {
      for (const row of rows) await replayRow(db, row, guard.assert)
    } finally {
      guard.detach()
      release()
    }
    throw error
  }
}

/** Remove only desktop acceptance projections, never unrelated task/code runs. */
export async function deleteManagedDesktopRunProjections(
  db: CogniaDB,
  sessionIds: readonly string[]
): Promise<void> {
  const rows = await db.executionRuns
    .where("sessionId")
    .anyOf([...sessionIds])
    .toArray()
  const runIds = rows
    .filter((run) => run.id.startsWith(MANAGED_DESKTOP_RUN_PREFIX))
    .map((run) => run.id)
  await deleteAcceptanceProjections(db, runIds)
}
async function deleteAcceptanceProjections(db: CogniaDB, runIds: string[]): Promise<void> {
  if (!runIds.length) return
  const bindingIds = await db.executionRunBindings.where("runId").anyOf(runIds).primaryKeys()
  await db.executionRunEvents.where("runId").anyOf(runIds).delete()
  await db.executionRunBindings.bulkDelete(bindingIds)
  await db.executionRunInterrupts.where("runId").anyOf(runIds).delete()
  await db.runResultSummaries.where("runId").anyOf(runIds).delete()
  await db.notificationProjectionWork.where("runId").anyOf(runIds).delete()
  await db.executionRuns.bulkDelete(runIds)
  await db.syncTombstones.bulkPut([
    ...runIds.map((id) => ({ table: "executionRuns" as const, id, deletedAt: Date.now() })),
    ...bindingIds.map((id) => ({
      table: "executionRunBindings" as const,
      id,
      deletedAt: Date.now(),
    })),
  ])
}

/** Acceptance-only variant of the canonical history delete, never a raw viewer RPC. */
export async function deleteManagedDesktopAcceptance(
  acceptanceId: string,
  conversationId: string,
  scope: SessionPersistenceScope
): Promise<void> {
  const release = await acquire()
  const db = scope.db
  const owner = useAccountStore.getState().unlockedAccountId
  if (!owner) {
    release()
    throw new Error("managed_desktop_authentication_required")
  }
  const guard = identityGuard(db, owner, scope.assertActive)
  let row: ManagedDesktopDeletionRow | undefined
  let committed = false
  try {
    guard.assert()
    const session = await db.sessions.get(conversationId)
    if (!session) throw new Error("managed_desktop_result_source_missing")
    assertSessionWritable(session, "delete")
    const runId = `${MANAGED_DESKTOP_RUN_PREFIX}${acceptanceId}`
    const run = await db.executionRuns.get(runId)
    if (!run || run.sessionId !== conversationId || !run.managedDesktopHostId)
      throw new Error("managed_desktop_result_source_missing")
    const hosts =
      session.deliverySourceHosts?.filter((host) => host.hostId === run.managedDesktopHostId) ?? []
    if (hosts.length !== 1) throw new Error("managed_desktop_deletion_original_host_required")
    guard.assert()
    const now = Date.now()
    row = {
      id: crypto.randomUUID(),
      ownerAccountId: owner,
      host: hosts[0]!,
      conversationIds: [],
      taskIds: [],
      acceptanceIds: [acceptanceId],
      phase: "preparing",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    }
    await db.managedDesktopDeletionOutbox.add(row)
    announce([row])
    try {
      await prepare(row, guard.assert)
    } catch {
      guard.assert()
    }
    const intent = row
    await db.transaction(
      "rw",
      [
        db.sessions,
        db.managedDesktopDeletionOutbox,
        db.executionRuns,
        db.executionRunEvents,
        db.executionRunBindings,
        db.executionRunInterrupts,
        db.runResultSummaries,
        db.notificationProjectionWork,
        db.syncTombstones,
      ],
      async () => {
        guard.assert()
        const current = await db.sessions.get(conversationId)
        const currentRun = await db.executionRuns.get(runId)
        assertSessionWritable(current, "delete")
        if (
          !current ||
          !currentRun ||
          currentRun.sessionId !== conversationId ||
          currentRun.managedDesktopHostId !== run.managedDesktopHostId ||
          JSON.stringify(current.deliverySourceHosts) !==
            JSON.stringify(session.deliverySourceHosts)
        )
          throw new Error("managed_desktop_deletion_scope_changed")
        await db.managedDesktopDeletionOutbox.update(intent.id, {
          phase: "committed",
          updatedAt: Date.now(),
        })
        await deleteAcceptanceProjections(db, [runId])
        guard.assert()
      }
    )
    committed = true
    row.phase = "committed"
    announce([row])
  } finally {
    try {
      if (row) {
        if (!committed) row.phase = "preparing"
        await replayRow(db, row, guard.assert).catch(() => undefined)
      }
    } finally {
      guard.detach()
      release()
    }
  }
}
