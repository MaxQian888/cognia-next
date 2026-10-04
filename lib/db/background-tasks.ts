import type {
  BackgroundTaskJournal,
  BackgroundTaskJournalPatch,
  BackgroundTaskJournalRecord,
  BackgroundTaskStatus,
  BackgroundDispatchRecovery,
  BackgroundTaskJournalWriter,
} from "@/lib/background-tasks/registry-core"
import { interruptRunningTasks } from "@/lib/background-tasks/registry-core"
import { getDb } from "./schema"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"

export const BACKGROUND_TASK_LEASE_TTL_MS = 60_000
const DEFAULT_OWNER_ID = crypto.randomUUID()
type OwnerLease = NonNullable<BackgroundTaskJournalRow["ownerLease"]>
type LeaseOptions = { ownerId?: string; now?: () => number }

function ownsRunningTask(
  row: BackgroundTaskJournalRow | undefined,
  lease: OwnerLease,
  now: number
): boolean {
  return Boolean(
    row?.status === "running" &&
    row.ownerLease?.ownerId === lease.ownerId &&
    row.ownerLease?.epoch === lease.epoch &&
    row.ownerLease.expiresAt > now
  )
}

function terminalPatch(current: BackgroundTaskJournalRow, patch: BackgroundTaskJournalPatch) {
  return {
    ...patch,
    ...(current.host === "renderer" &&
    current.kind === "subagent" &&
    current.mode !== "foreground" &&
    (patch.status === "done" || patch.status === "error")
      ? { deliveryState: current.deliveryState ?? "pending" }
      : {}),
  }
}

function changesExecution(patch: BackgroundTaskJournalPatch): boolean {
  return ["status", "settledAt", "resultText", "error", "usage", "cancelRequestedAt"].some(
    (key) => key in patch
  )
}

export type BackgroundTaskJournalRow = BackgroundTaskJournalRecord

export interface BackgroundTaskListFilter {
  host?: BackgroundTaskJournalRow["host"]
  status?: BackgroundTaskStatus
}

export async function recordBackgroundTaskStart(row: BackgroundTaskJournalRow): Promise<void> {
  await getDb().backgroundTasks.add(row)
}

export async function recordBackgroundTaskSettle(
  runId: string,
  patch: BackgroundTaskJournalPatch
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.backgroundTasks, async () => {
    const current = await db.backgroundTasks.get(runId)
    if (!current) return
    if (current.ownerLease) throw new Error("Background task ownership required")
    await db.backgroundTasks.update(runId, terminalPatch(current, patch))
  })
}

export async function updateBackgroundTaskRecord(
  runId: string,
  patch: BackgroundTaskJournalPatch
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.backgroundTasks, async () => {
    const current = await db.backgroundTasks.get(runId)
    if (current?.ownerLease && changesExecution(patch))
      throw new Error("Background task ownership required")
    await db.backgroundTasks.update(runId, patch)
  })
}

export async function getBackgroundTaskRecord(
  runId: string
): Promise<BackgroundTaskJournalRow | undefined> {
  return getDb().backgroundTasks.get(runId)
}

export async function listBackgroundTaskRecords(
  filter: BackgroundTaskListFilter = {}
): Promise<BackgroundTaskJournalRow[]> {
  const db = getDb()
  let rows: BackgroundTaskJournalRow[]
  if (filter.host && filter.status) {
    rows = await db.backgroundTasks
      .where("[host+status]")
      .equals([filter.host, filter.status])
      .toArray()
  } else if (filter.host) {
    rows = await db.backgroundTasks.where("host").equals(filter.host).toArray()
  } else if (filter.status) {
    rows = await db.backgroundTasks.where("status").equals(filter.status).toArray()
  } else {
    rows = await db.backgroundTasks.toArray()
  }
  return rows.sort((a, b) => b.startedAt - a.startedAt)
}

export async function clearSettledBackgroundTasks(
  filter: BackgroundTaskListFilter = {}
): Promise<void> {
  const db = getDb()
  const rows = await listBackgroundTaskRecords(filter)
  const settled = rows.filter((row) => row.status !== "running").map((row) => row.runId)
  if (settled.length > 0) await db.backgroundTasks.bulkDelete(settled)
}

export function createDexieBackgroundTaskJournal(
  options: LeaseOptions = {}
): BackgroundTaskJournal & {
  renewLease(runId: string): Promise<boolean>
} {
  const now = options.now ?? Date.now
  const ownerId = options.ownerId ?? DEFAULT_OWNER_ID
  const admissions = new Map<string, { db: ReturnType<typeof getDb>; lease: OwnerLease }>()
  const requireAdmission = (runId: string) => {
    const admission = admissions.get(runId)
    if (!admission) throw new Error("Background task ownership required")
    if (getDb() !== admission.db) throw new Error("Background task scope changed")
    return admission
  }
  return {
    leaseIntervalMs: BACKGROUND_TASK_LEASE_TTL_MS / 3,
    async recordStart(record) {
      if (admissions.has(record.runId)) throw new Error("Background run already exists")
      const db = getDb()
      const lease = { ownerId, epoch: 1, expiresAt: now() + BACKGROUND_TASK_LEASE_TTL_MS }
      // Capture before the first await so immediately-settled promises remain scoped.
      admissions.set(record.runId, { db, lease })
      try {
        await db.backgroundTasks.add({
          ...record,
          ...(record.host === "renderer" ? { ownerLease: lease } : {}),
        })
      } catch (error) {
        admissions.delete(record.runId)
        throw error
      }
    },
    async recordSettle(runId, patch) {
      const captured = admissions.get(runId)
      try {
        const { db, lease } = requireAdmission(runId)
        await db.transaction("rw", db.backgroundTasks, async () => {
          requireAdmission(runId)
          const current = await db.backgroundTasks.get(runId)
          requireAdmission(runId)
          if (!current || (current.host === "renderer" && !ownsRunningTask(current, lease, now())))
            throw new Error("Background task ownership lost")
          await db.backgroundTasks.update(runId, terminalPatch(current, patch))
        })
      } finally {
        if (admissions.get(runId) === captured) admissions.delete(runId)
      }
    },
    async renewLease(runId) {
      const admission = admissions.get(runId)
      if (!admission) return false
      if (getDb() !== admission.db) {
        admissions.delete(runId)
        return false
      }
      const { db, lease } = admission
      const renewed = await db.transaction("rw", db.backgroundTasks, async () => {
        if (getDb() !== db) return false
        const current = await db.backgroundTasks.get(runId)
        if (getDb() !== db) return false
        const at = now()
        if (!ownsRunningTask(current, lease, at)) return false
        if (current?.cancelRequestedAt !== undefined) return "cancelled" as const
        await db.backgroundTasks.update(runId, {
          ownerLease: { ...lease, expiresAt: at + BACKGROUND_TASK_LEASE_TTL_MS },
        })
        return true
      })
      if (renewed === false && admissions.get(runId) === admission) admissions.delete(runId)
      return renewed === true
    },
    list: listBackgroundTaskRecords,
    get: getBackgroundTaskRecord,
    async update(runId, patch) {
      if (!changesExecution(patch)) {
        if (admissions.has(runId)) requireAdmission(runId)
        return updateBackgroundTaskRecord(runId, patch)
      }
      const { db, lease } = requireAdmission(runId)
      await db.transaction("rw", db.backgroundTasks, async () => {
        requireAdmission(runId)
        const current = await db.backgroundTasks.get(runId)
        requireAdmission(runId)
        if (!ownsRunningTask(current, lease, now()))
          throw new Error("Background task ownership lost")
        await db.backgroundTasks.update(runId, patch)
      })
    },
    clearSettled: clearSettledBackgroundTasks,
  }
}

/**
 * Reconcile orphaned runs atomically with settlement. Versioned, unclaimed
 * recovery remains discoverable if a previous boot died before redispatch;
 * legacy interrupted history stays inert. The dispatcher still verifies all
 * identity, policy, effect, and attempt evidence before accepting a restart.
 */
export async function interruptBackgroundTasksOnBoot(
  options: {
    now?: () => number
    host?: BackgroundTaskJournalRow["host"]
    isLive?: (runId: string) => boolean
    recoverInterrupted?: boolean
  } = {}
): Promise<BackgroundTaskJournalRow[]> {
  const db = getDb()
  return db.transaction("rw", db.backgroundTasks, async () => {
    const at = (options.now ?? Date.now)()
    const rows = (await db.backgroundTasks.toArray()).filter(
      (row) =>
        (!options.host || row.host === options.host) &&
        (row.ownerLease !== undefined || !options.isLive?.(row.runId)) &&
        !(row.host === "renderer" && row.ownerLease && row.ownerLease.expiresAt > at)
    )
    const unknownOwners = new Set(
      rows.filter((row) => row.host === "renderer" && !row.ownerLease).map((row) => row.runId)
    )
    const interrupted = await interruptRunningTasks(
      {
        ...createDexieBackgroundTaskJournal(),
        list: async () => rows,
        update: async (runId, patch) => {
          await db.backgroundTasks.update(runId, {
            ...patch,
            ...(unknownOwners.has(runId)
              ? {
                  error: "Background task ownership is unknown; automatic recovery is unavailable.",
                }
              : {}),
          })
        },
      },
      options
    )
    return [
      ...interrupted.filter((row) => row.host !== "renderer" || row.ownerLease),
      ...(options.recoverInterrupted
        ? rows.filter(
            (row) =>
              row.status === "interrupted" &&
              (row.host !== "renderer" || row.ownerLease !== undefined) &&
              row.recovery?.version === 1 &&
              !row.resumedByRunId &&
              row.cancelRequestedAt === undefined
          )
        : []),
    ]
  })
}

/** Default retention for settled journal rows (age + cap; running rows never pruned). */
export const BACKGROUND_TASK_PRUNE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
export const BACKGROUND_TASK_PRUNE_MAX_ITEMS = 200

/**
 * Prune settled journal rows, modeled on `pruneNotifications`: drop rows whose
 * settle (or start, for settle-less rows) is older than `maxAgeMs`, then trim
 * to the newest `maxItems`. `running` rows are never pruned. Returns the
 * number of rows removed.
 */
export async function pruneBackgroundTaskRecords(opts: {
  now: number
  maxAgeMs?: number
  maxItems?: number
  host?: BackgroundTaskJournalRow["host"]
}): Promise<number> {
  const maxAgeMs = opts.maxAgeMs ?? BACKGROUND_TASK_PRUNE_MAX_AGE_MS
  const maxItems = opts.maxItems ?? BACKGROUND_TASK_PRUNE_MAX_ITEMS
  const db = getDb()
  let removed = 0
  await db.transaction("rw", db.backgroundTasks, async () => {
    const rows = await listBackgroundTaskRecords(opts.host ? { host: opts.host } : {})
    const settled = rows.filter((row) => row.status !== "running")
    const doomed = new Set<string>()
    if (maxAgeMs > 0) {
      const cutoff = opts.now - maxAgeMs
      for (const row of settled) {
        if ((row.settledAt ?? row.startedAt) < cutoff) doomed.add(row.runId)
      }
    }
    if (maxItems > 0) {
      // listBackgroundTaskRecords sorts newest-first by startedAt.
      const survivors = settled.filter((row) => !doomed.has(row.runId))
      for (const row of survivors.slice(maxItems)) doomed.add(row.runId)
    }
    if (doomed.size > 0) {
      await db.backgroundTasks.bulkDelete([...doomed])
      removed = doomed.size
    }
  })
  return removed
}

/** Admission and child ownership commit together, before any provider work. */
export async function admitBackgroundDispatch(
  row: BackgroundTaskJournalRow,
  recoveryOf?: string,
  expectedRecoveryPhase?: BackgroundDispatchRecovery["phase"],
  options: LeaseOptions = {}
): Promise<{
  journal: BackgroundTaskJournalWriter
  markDispatched: () => Promise<void>
  requestCancel: () => Promise<void>
  renewLease: () => Promise<boolean>
}> {
  const db = getDb()
  const now = options.now ?? Date.now
  let lease: OwnerLease = {
    ownerId: options.ownerId ?? DEFAULT_OWNER_ID,
    epoch: 1,
    expiresAt: now() + BACKGROUND_TASK_LEASE_TTL_MS,
  }
  const recovery = row.recovery
  if (!recovery || db.name !== recovery.namespaceId)
    throw new Error("Background dispatch scope changed")
  await db.transaction("rw", db.backgroundTasks, db.sessions, async () => {
    if (getDb() !== db) throw new Error("Background dispatch scope changed")
    const parent = await db.sessions.get(row.sessionId)
    if (!parent) throw new Error("Background dispatch parent no longer exists")
    assertSessionWritable(parent, "continue-run")
    if (await db.backgroundTasks.get(row.runId)) throw new Error("Background run already exists")
    if (recoveryOf) {
      const prior = await db.backgroundTasks.get(recoveryOf)
      if (
        !prior ||
        prior.status !== "interrupted" ||
        !prior.ownerLease ||
        prior.ownerLease.expiresAt > now() ||
        prior.resumedByRunId ||
        prior.cancelRequestedAt !== undefined ||
        prior.recovery?.phase !== expectedRecoveryPhase ||
        prior.recovery?.contextFingerprint !== recovery.contextFingerprint ||
        prior.recovery?.executionSessionId !== recovery.executionSessionId
      ) {
        throw new Error("Background recovery was already claimed or changed")
      }
      const child = await db.sessions.get(recovery.executionSessionId)
      if (
        !child ||
        child.parentSessionId !== row.sessionId ||
        child.attachedChild?.status === "closed"
      ) {
        throw new Error("Background child session no longer exists")
      }
      assertSessionWritable(child, "continue-run")
      lease = { ...lease, epoch: prior.ownerLease.epoch + 1 }
      await db.backgroundTasks.update(recoveryOf, { resumedByRunId: row.runId })
    } else {
      // Explicit hidden child ownership reuses the attached-session deletion cascade.
      await db.sessions.add({
        id: recovery.executionSessionId,
        title: row.label ?? row.subagentId,
        kind: "subagent",
        visibility: "embedded",
        parentSessionId: parent.id,
        projectId: parent.projectId,
        workingDir: recovery.caller.cwd,
        createdAt: row.startedAt,
        updatedAt: row.startedAt,
        attachedChild: {
          parentSessionId: parent.id,
          lifecycleOwnerSessionId: parent.id,
          context: { mode: "none" },
          workspace: "shared",
          status: "staged",
          createdAt: row.startedAt,
        },
      })
    }
    await db.backgroundTasks.add({ ...row, ownerLease: lease })
  })
  const assertScope = () => {
    if (getDb() !== db) throw new Error("Background dispatch scope changed")
  }
  const renewLease = async () => {
    if (getDb() !== db) return false
    return db.transaction("rw", db.backgroundTasks, async () => {
      if (getDb() !== db) return false
      const current = await db.backgroundTasks.get(row.runId)
      if (getDb() !== db) return false
      const at = now()
      if (!ownsRunningTask(current, lease, at) || current?.cancelRequestedAt !== undefined)
        return false
      await db.backgroundTasks.update(row.runId, {
        ownerLease: { ...lease, expiresAt: at + BACKGROUND_TASK_LEASE_TTL_MS },
      })
      return true
    })
  }
  return {
    renewLease,
    journal: {
      leaseIntervalMs: BACKGROUND_TASK_LEASE_TTL_MS / 3,
      renewLease: async (runId) => runId === row.runId && renewLease(),
      recordStart: () => {
        throw new Error("Background admission already committed")
      },
      async recordSettle(runId, patch) {
        assertScope()
        await db.transaction("rw", db.backgroundTasks, db.sessions, async () => {
          assertScope()
          const current = await db.backgroundTasks.get(runId)
          assertScope()
          if (runId !== row.runId || !current || !ownsRunningTask(current, lease, now()))
            throw new Error("Background run no longer active")
          await db.backgroundTasks.update(runId, terminalPatch(current, patch))
          const child = await db.sessions.get(recovery.executionSessionId)
          if (child?.attachedChild && child.attachedChild.status !== "closed") {
            await db.sessions.update(child.id, {
              attachedChild: {
                ...child.attachedChild,
                status: patch.status === "done" ? "completed" : "interrupted",
                updatedAt: patch.settledAt,
              },
            })
          }
        })
        assertScope()
      },
    },
    async requestCancel() {
      assertScope()
      await db.transaction("rw", db.backgroundTasks, async () => {
        assertScope()
        const current = await db.backgroundTasks.get(row.runId)
        assertScope()
        if (!current || !ownsRunningTask(current, lease, now()))
          throw new Error("Background run no longer active")
        await db.backgroundTasks.update(row.runId, {
          cancelRequestedAt: current.cancelRequestedAt ?? now(),
        })
      })
      assertScope()
    },
    async markDispatched() {
      assertScope()
      await db.transaction("rw", db.backgroundTasks, db.sessions, async () => {
        assertScope()
        const current = await db.backgroundTasks.get(row.runId)
        const parent = await db.sessions.get(row.sessionId)
        const child = await db.sessions.get(recovery.executionSessionId)
        assertScope()
        assertSessionWritable(parent, "continue-run")
        assertSessionWritable(child, "continue-run")
        if (
          !parent ||
          !child ||
          child.attachedChild?.status === "closed" ||
          current?.status !== "running" ||
          !ownsRunningTask(current, lease, now()) ||
          current.cancelRequestedAt !== undefined ||
          current.recovery?.phase !== "accepted"
        ) {
          throw new Error("Background admission is no longer executable")
        }
        await db.backgroundTasks.update(row.runId, {
          recovery: { ...recovery, phase: "dispatched" } satisfies BackgroundDispatchRecovery,
        })
        if (child.attachedChild)
          await db.sessions.update(child.id, {
            attachedChild: { ...child.attachedChild, status: "running", updatedAt: now() },
          })
      })
      assertScope()
    },
  }
}

/** Keep a pending batch's identity stable across reload and newly arriving results. */
export async function reserveBackgroundTaskDelivery(
  sessionId: string,
  runIds: string[],
  deliveryId: string
): Promise<{ deliveryId: string; runIds: string[] } | null> {
  const db = getDb()
  return db.transaction("rw", db.backgroundTasks, async () => {
    const rows = (await db.backgroundTasks.bulkGet(runIds)).filter(
      (row): row is BackgroundTaskJournalRow =>
        Boolean(
          row &&
          row.sessionId === sessionId &&
          row.host === "renderer" &&
          row.kind === "subagent" &&
          row.deliveryState === "pending" &&
          (row.status === "done" || row.status === "error")
        )
    )
    const existingId = rows.find((row) => row.deliveryId)?.deliveryId
    const batch = existingId ? rows.filter((row) => row.deliveryId === existingId) : rows
    if (batch.length === 0) return null
    const id = existingId ?? deliveryId
    if (!existingId) {
      await Promise.all(
        batch.map((row) => db.backgroundTasks.update(row.runId, { deliveryId: id }))
      )
    }
    return { deliveryId: id, runIds: batch.map((row) => row.runId) }
  })
}
