import type { MobileOutboundJobRow } from "./mobile-outbound-types"
import { getDb } from "./schema"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import type { MobileStepReceiptRow } from "@/types/mobile/mobile-step-receipt"

export const MOBILE_STEP_TOMBSTONE_MS = 24 * 60 * 60 * 1000

export interface MobileStepResultChunkInput {
  requestId: string
  seq: number
  total: number
  chunk: string
}

export interface BeginMobileStepInput {
  requestId: string
  deviceId: string
  kind: string
  timeoutAt: number
  now?: number
  accountId?: string
  targetId?: string
}

export type BeginMobileStepOutcome =
  | { execute: true; receipt: MobileStepReceiptRow }
  | { execute: false; status: MobileStepReceiptRow["status"] }

/** Persist the replay guard before native UI opens. */
export async function beginMobileStepReceipt(
  input: BeginMobileStepInput
): Promise<BeginMobileStepOutcome> {
  const db = getDb()
  const scope = getActiveRuntimeTargetContext()
  const accountId = input.accountId ?? scope?.accountId
  const targetId = input.targetId ?? scope?.targetId
  if (!accountId || !targetId) throw new Error("mobile step receipt requires an active Host target")
  const now = input.now ?? Date.now()

  return db.transaction("rw", db.mobileStepReceipts, async () => {
    const existing = await db.mobileStepReceipts.get(input.requestId)
    if (existing) return { execute: false, status: existing.status }
    const receipt: MobileStepReceiptRow = {
      requestId: input.requestId,
      deviceId: input.deviceId,
      accountId,
      targetId,
      kind: input.kind,
      status: "executing",
      createdAt: now,
      updatedAt: now,
      timeoutAt: input.timeoutAt,
    }
    await db.mobileStepReceipts.add(receipt)
    return { execute: true, receipt }
  })
}

function resultQueueRow(
  receipt: MobileStepReceiptRow,
  chunk: MobileStepResultChunkInput,
  now: number
): MobileOutboundJobRow {
  const id = `mobile-step-result:${chunk.requestId}:${chunk.seq}`
  return {
    id,
    accountId: receipt.accountId,
    targetId: receipt.targetId,
    command: "workflow_step_result",
    payload: chunk,
    status: "pending",
    attempts: 0,
    createdAt: now,
    nextAttemptAt: now,
    idempotencyKey: id,
    label: `Remote step result ${chunk.requestId}`,
  }
}

/** Atomically retain the result and enqueue every Host-bound chunk. */
export async function persistMobileStepResult(
  requestId: string,
  chunks: readonly MobileStepResultChunkInput[],
  now = Date.now()
): Promise<void> {
  if (chunks.length === 0 || chunks.some((chunk) => chunk.requestId !== requestId)) {
    throw new Error("mobile step result chunks do not match the receipt")
  }
  const ordered = [...chunks].sort((left, right) => left.seq - right.seq)
  if (
    ordered.some(
      (chunk, index) => chunk.seq !== index || chunk.total !== ordered.length || !chunk.chunk
    )
  ) {
    throw new Error("mobile step result chunks are malformed")
  }
  const db = getDb()
  await db.transaction("rw", db.mobileStepReceipts, db.mobileOutboundQueue, async () => {
    const receipt = await db.mobileStepReceipts.get(requestId)
    if (!receipt) throw new Error(`mobile step receipt ${requestId} not found`)
    if (receipt.status === "acknowledged" || receipt.status === "result-pending") return
    const resultJson = ordered.map((chunk) => chunk.chunk).join("")
    await db.mobileOutboundQueue.bulkPut(
      ordered.map((chunk) => resultQueueRow(receipt, chunk, now))
    )
    await db.mobileStepReceipts.update(requestId, {
      status: "result-pending",
      resultJson,
      resultChunkCount: ordered.length,
      acknowledgedChunks: [],
      updatedAt: now,
    })
  })
}

/** Convert interrupted native UI into a terminal result without reopening it. */
export async function recoverInterruptedMobileSteps(
  deviceId: string,
  makeChunks: (
    requestId: string,
    result: { ok: false; code: "interrupted"; message: string }
  ) => MobileStepResultChunkInput[],
  now = Date.now()
): Promise<number> {
  const db = getDb()
  const rows = await db.mobileStepReceipts
    .where("[deviceId+status]")
    .equals([deviceId, "executing"])
    .toArray()
  for (const row of rows) {
    await persistMobileStepResult(
      row.requestId,
      makeChunks(row.requestId, {
        ok: false,
        code: "interrupted",
        message: "the device restarted while the mobile step was executing",
      }),
      now
    )
  }
  return rows.length
}

/** Record one Host ACK; the final ACK erases all sensitive result content. */
export async function acknowledgeMobileStepResultChunk(
  requestId: string,
  seq: number,
  now = Date.now()
): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.mobileStepReceipts, async () => {
    const receipt = await db.mobileStepReceipts.get(requestId)
    if (!receipt || receipt.status === "acknowledged") return receipt?.status === "acknowledged"
    const acknowledged = new Set(receipt.acknowledgedChunks ?? [])
    acknowledged.add(seq)
    const complete = acknowledged.size >= (receipt.resultChunkCount ?? Number.POSITIVE_INFINITY)
    if (!complete) {
      await db.mobileStepReceipts.update(requestId, {
        acknowledgedChunks: [...acknowledged].sort((a, b) => a - b),
        updatedAt: now,
      })
      return false
    }
    await db.mobileStepReceipts.put({
      requestId: receipt.requestId,
      deviceId: receipt.deviceId,
      accountId: receipt.accountId,
      targetId: receipt.targetId,
      kind: receipt.kind,
      status: "acknowledged",
      createdAt: receipt.createdAt,
      updatedAt: now,
      timeoutAt: receipt.timeoutAt,
      expiresAt: now + MOBILE_STEP_TOMBSTONE_MS,
    })
    return true
  })
}

export async function vacuumMobileStepTombstones(now = Date.now()): Promise<number> {
  const db = getDb()
  const expired = await db.mobileStepReceipts
    .where("expiresAt")
    .belowOrEqual(now)
    .filter((row) => row.status === "acknowledged")
    .primaryKeys()
  await db.mobileStepReceipts.bulkDelete(expired)
  return expired.length
}
