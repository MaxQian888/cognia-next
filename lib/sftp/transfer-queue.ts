/**
 * The durable SFTP transfer queue (ADR-0162).
 *
 * A transfer is a row before it is an operation. That ordering is the whole
 * design: the interface enqueues, the pump picks up, and a reload or a crash
 * leaves the queue describing exactly what it did and did not finish. The
 * alternative, a promise held by whichever component happened to start it,
 * loses every transfer the moment somebody navigates away.
 *
 * # What resuming costs
 *
 * Almost nothing, because the host owns the write head. An upload resumes from
 * what is already on the remote machine, which the host reads at `_open`, so
 * the row needs only the source bytes. A download resumes from the bytes
 * already received, which the row carries, because the host reads from an
 * explicit offset.
 *
 * # Why transfers are not faster than this
 *
 * The obvious lever, several chunks in flight at once, buys nothing today: the
 * host pools one SFTP session per profile configuration and takes its lock for
 * the whole of each operation, so concurrent reads queue behind each other one
 * hop further down. The lever that does work is the chunk size, which the host
 * negotiates at `_open`. Saying this out loud rather than shipping a
 * concurrency knob that does nothing is the point.
 *
 * # Approval
 *
 * A paired device needs an interactive approval before a transfer opens, and it
 * is deliberately not persisted with the row: a lease is a credential, and a
 * queue that stored one would hand every future transfer an approval a person
 * gave once. It lives in memory here, set by an explicit user action, and a
 * transfer that finds none parks itself rather than failing.
 */

import Dexie from "dexie"

import { getDb } from "@/lib/db/schema"
import {
  downloadSftpFile,
  uploadSftpFile,
  SftpTransferAbortedError,
  type SftpTransferProgress,
} from "./client"
import {
  isSftpTransferFinished,
  SFTP_MAX_QUEUED_BYTES,
  SftpTransferTooLargeError,
  type SftpTransferDirection,
  type SftpTransferRow,
  type SftpTransferStatus,
} from "./transfer-types"

export type { SftpTransferRow, SftpTransferStatus, SftpTransferDirection }
export { isSftpTransferFinished, SFTP_MAX_QUEUED_BYTES, SftpTransferTooLargeError }

/** How often progress reaches the database while a transfer runs. */
const PROGRESS_WRITE_INTERVAL_MS = 500

/** How many transfers run at once. */
const DEFAULT_CONCURRENCY = 2

/** The refusal a parked transfer carries when nobody has approved it yet. */
export const SFTP_APPROVAL_REQUIRED = "sftp_approval_required"

interface ApprovalHolder {
  token: string | null
  expiresAt: number
}

const approval: ApprovalHolder = { token: null, expiresAt: 0 }
const running = new Map<string, AbortController>()

function now(): number {
  return Date.now()
}

/**
 * Record the approval a user just gave, for as long as it is good for.
 *
 * `null` is the desktop's answer and means "none needed", which is why the
 * expiry is only consulted for a real token. Nothing here writes it to disk.
 */
export function setSftpTransferApproval(token: string | null, expiresAt = 0): void {
  approval.token = token
  approval.expiresAt = expiresAt
}

export function clearSftpTransferApproval(): void {
  approval.token = null
  approval.expiresAt = 0
}

/** The live approval, or null when there is none and none has been given. */
export function currentSftpTransferApproval(): string | null {
  if (!approval.token) return null
  if (approval.expiresAt > 0 && approval.expiresAt <= now()) return null
  return approval.token
}

function leafOf(remotePath: string): string {
  const parts = remotePath.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? remotePath
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `sftp-${now()}-${Math.round(Math.random() * 1e9)}`
}

async function insert(
  row: Omit<SftpTransferRow, "id" | "status" | "transferred" | "createdAt" | "updatedAt">
): Promise<string> {
  const id = newId()
  const stamp = now()
  await getDb().sftpTransfers.put({
    ...row,
    id,
    status: "queued",
    transferred: 0,
    createdAt: stamp,
    updatedAt: stamp,
  })
  return id
}

export interface EnqueueDownloadInput {
  profileId: string
  profileLabel: string
  remotePath: string
  /** What the machine said the file was, so the row can show a total at once. */
  size: number
}

export async function enqueueSftpDownload(input: EnqueueDownloadInput): Promise<string> {
  return insert({
    profileId: input.profileId,
    profileLabel: input.profileLabel,
    remotePath: input.remotePath,
    fileName: leafOf(input.remotePath),
    direction: "download",
    size: input.size,
    errorCode: null,
    errorMessage: null,
  })
}

export interface EnqueueUploadInput {
  profileId: string
  profileLabel: string
  /** Absolute destination path on the remote machine, including the file name. */
  remotePath: string
  body: Blob
}

/**
 * Queue an upload, reading the file into the row.
 *
 * The read happens here rather than at send time because the row has to be able
 * to outlive whatever picked the file: a `File` handle does not survive a
 * reload, and a queue whose upload cannot be performed after a restart is a
 * queue that lied about being durable.
 */
export async function enqueueSftpUpload(input: EnqueueUploadInput): Promise<string> {
  if (input.body.size > SFTP_MAX_QUEUED_BYTES) {
    throw new SftpTransferTooLargeError(input.body.size)
  }
  const payload = new Uint8Array(await input.body.arrayBuffer())
  return insert({
    profileId: input.profileId,
    profileLabel: input.profileLabel,
    remotePath: input.remotePath,
    fileName: leafOf(input.remotePath),
    direction: "upload",
    size: payload.byteLength,
    errorCode: null,
    errorMessage: null,
    payload,
  })
}

async function patch(id: string, changes: Partial<SftpTransferRow>): Promise<void> {
  await getDb().sftpTransfers.update(id, { ...changes, updatedAt: now() })
}

/**
 * Stop a running transfer and keep what it has.
 *
 * An upload's partial file is deliberately left on the remote machine: removing
 * it would be a delete nobody asked for, and those bytes are what the resume
 * starts from.
 */
export async function pauseSftpTransfer(id: string): Promise<void> {
  running.get(id)?.abort()
  const row = await getDb().sftpTransfers.get(id)
  if (!row || isSftpTransferFinished(row.status)) return
  await patch(id, { status: "paused" })
}

export async function resumeSftpTransfer(id: string): Promise<void> {
  const row = await getDb().sftpTransfers.get(id)
  if (!row || row.status === "running") return
  await patch(id, { status: "queued", errorCode: null, errorMessage: null })
}

export async function cancelSftpTransfer(id: string): Promise<void> {
  running.get(id)?.abort()
  // The received bytes go too. A cancelled transfer is a decision, and keeping
  // its partial payload would leave the largest thing in the row behind for a
  // resume that is never coming.
  await patch(id, { status: "cancelled", received: undefined, payload: undefined })
}

export async function retrySftpTransfer(id: string): Promise<void> {
  const row = await getDb().sftpTransfers.get(id)
  if (!row) return
  await patch(id, {
    status: "queued",
    errorCode: null,
    errorMessage: null,
    // A retry starts over. Resuming a failure whose cause was a truncated read
    // would carry the truncation forward, and the caller asked to try again.
    transferred: 0,
    received: undefined,
  })
}

export async function clearFinishedSftpTransfers(profileId?: string): Promise<number> {
  const table = getDb().sftpTransfers
  const rows = await (profileId ? table.where("profileId").equals(profileId) : table.toCollection())
    .filter((row) => isSftpTransferFinished(row.status))
    .toArray()
  await table.bulkDelete(rows.map((row) => row.id))
  return rows.length
}

/** Live rows, newest first. `Dexie.liveQuery` rather than the named export. */
export function observeSftpTransfers(profileId?: string) {
  return Dexie.liveQuery(async () => {
    const table = getDb().sftpTransfers
    const rows = await (
      profileId ? table.where("profileId").equals(profileId) : table.toCollection()
    ).toArray()
    return rows.sort((left, right) => right.createdAt - left.createdAt)
  })
}

function failureOf(error: unknown): { code: string; message: string } {
  const text = error instanceof Error ? error.message : String(error ?? "")
  // The service prefixes its code, and the machine's own words follow it. Both
  // halves matter: the code is what an interface branches on, the words are
  // what a person acts on.
  const match = /^([a-z_]+):\s*(.*)$/s.exec(text)
  return match ? { code: match[1], message: match[2] } : { code: "sftp_failed", message: text }
}

async function runOne(row: SftpTransferRow): Promise<void> {
  const controller = new AbortController()
  running.set(row.id, controller)
  let lastWrite = 0
  const onProgress = (progress: SftpTransferProgress) => {
    const stamp = now()
    if (stamp - lastWrite < PROGRESS_WRITE_INTERVAL_MS) return
    lastWrite = stamp
    void patch(row.id, { transferred: progress.transferred, size: progress.total })
  }
  try {
    await patch(row.id, { status: "running", errorCode: null, errorMessage: null })
    if (row.direction === "download") {
      const blob = await downloadSftpFile(row.profileId, row.remotePath, {
        adminLease: currentSftpTransferApproval(),
        signal: controller.signal,
        onProgress,
        resumeFrom: row.received,
      })
      const received = new Uint8Array(await blob.arrayBuffer())
      await patch(row.id, {
        status: "done",
        transferred: received.byteLength,
        size: received.byteLength,
        received,
      })
      return
    }
    if (!row.payload) {
      // The bytes are gone, which is what a row restored from a database
      // written by an older build looks like. Saying so beats retrying an
      // upload of nothing.
      await patch(row.id, {
        status: "failed",
        errorCode: "sftp_payload_missing",
        errorMessage: "the file to upload is no longer held by this device",
      })
      return
    }
    const result = await uploadSftpFile(row.profileId, row.remotePath, new Blob([row.payload]), {
      adminLease: currentSftpTransferApproval(),
      signal: controller.signal,
      onProgress,
    })
    await patch(row.id, {
      status: result.complete ? "done" : "failed",
      transferred: result.size,
      errorCode: result.complete ? null : "sftp_incomplete",
      errorMessage: result.complete
        ? null
        : `the machine holds ${result.size} of ${result.declaredSize} bytes`,
    })
  } catch (error) {
    if (error instanceof SftpTransferAbortedError) {
      // `pause` and `cancel` already wrote the status they meant. Overwriting
      // it here would turn a cancellation into a pause on the way out.
      return
    }
    const failure = failureOf(error)
    await patch(row.id, {
      status: "failed",
      errorCode: failure.code,
      errorMessage: failure.message,
    })
  } finally {
    running.delete(row.id)
  }
}

/**
 * Whether this transfer may start.
 *
 * A remote shell needs an approval, and the honest answer to not having one is
 * to park the row where a person can approve it, not to fail it. Failing would
 * read as "the machine refused you", which is a different thing entirely.
 */
async function parkIfUnapproved(row: SftpTransferRow, needsApproval: boolean): Promise<boolean> {
  if (!needsApproval || currentSftpTransferApproval()) return false
  await patch(row.id, {
    status: "paused",
    errorCode: SFTP_APPROVAL_REQUIRED,
    errorMessage: "this transfer needs your approval on the host before it can start",
  })
  return true
}

export interface SftpTransferPumpOptions {
  concurrency?: number
  /**
   * Whether an approval is required at all. Defaults to "not on the desktop",
   * which is what the manifest's interactive approval actually means: it exists
   * so a remote device asks a human at the host.
   */
  requiresApproval?: boolean
  /** Test seam, so a suite can drive the pump without a timer. */
  pollIntervalMs?: number
}

/**
 * Drive the queue until stopped.
 *
 * Returns the stop function. Anything still running is left alone rather than
 * aborted: stopping the pump is a lifecycle event, and killing a transfer in
 * flight is a user decision.
 */
export function startSftpTransferPump(options: SftpTransferPumpOptions = {}): () => void {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
  const interval = Math.max(50, options.pollIntervalMs ?? 750)
  const needsApproval = options.requiresApproval ?? true
  let stopped = false

  const tick = async () => {
    if (stopped) return
    const free = concurrency - running.size
    if (free <= 0) return
    const queued = await getDb().sftpTransfers.where("status").equals("queued").sortBy("createdAt")
    for (const row of queued.slice(0, free)) {
      if (stopped || running.has(row.id)) continue
      if (await parkIfUnapproved(row, needsApproval)) continue
      void runOne(row)
    }
  }

  // A row left `running` by a process that is gone is not running. Parking it
  // is the truthful state and lets the user restart it deliberately.
  const reconcile = async () => {
    const stale = await getDb().sftpTransfers.where("status").equals("running").toArray()
    for (const row of stale) {
      if (running.has(row.id)) continue
      await patch(row.id, { status: "paused" })
    }
  }

  void reconcile().then(tick)
  const timer = setInterval(() => void tick(), interval)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/** Test seam: forget every in-memory handle without touching the database. */
export function __resetSftpTransferRuntimeForTests(): void {
  for (const controller of running.values()) controller.abort()
  running.clear()
  clearSftpTransferApproval()
}
