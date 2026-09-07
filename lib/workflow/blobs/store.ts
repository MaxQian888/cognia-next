/**
 * Run-scoped encrypted blob store for workflow steps.
 *
 * See `types/workflow/blob.ts` for why this exists rather than putting bytes
 * in a step output. The crypto follows `lib/db/workflow-human-input-files.ts`:
 * an account-scoped key, AES-GCM, and additional authenticated data that binds
 * the ciphertext to the exact run, step and blob it was written for, so a row
 * moved between runs fails to decrypt rather than silently reading back.
 */

import {
  decryptAccountArtifactBytes,
  encryptAccountArtifactBytes,
  loadOrCreateAccountArtifactKey,
} from "@/lib/ai/eval/artifact-crypto"
import { getDb } from "@/lib/db/schema"
import {
  WORKFLOW_BLOB_MAX_BYTES,
  WORKFLOW_BLOB_REF_PREFIX,
  WORKFLOW_BLOB_TTL_MS,
  type WorkflowBlobHandle,
  type WorkflowBlobRow,
} from "@/types/workflow/blob"

export class WorkflowBlobError extends Error {
  constructor(
    readonly code: "too-large" | "empty" | "not-found" | "expired" | "no-account",
    message: string
  ) {
    super(message)
    this.name = "WorkflowBlobError"
  }
}

export interface StoreWorkflowBlobInput {
  accountId: string
  runId: string
  stepId: string
  bytes: Uint8Array
  mediaType: string
  width?: number
  height?: number
  now?: number
}

function additionalData(row: {
  accountId: string
  runId: string
  stepId: string
  id: string
}): Uint8Array {
  return new TextEncoder().encode(
    `workflow-blob-v1:${row.accountId}:${row.runId}:${row.stepId}:${row.id}`
  )
}

export function isWorkflowBlobRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(WORKFLOW_BLOB_REF_PREFIX)
}

export function workflowBlobId(ref: string): string {
  return ref.slice(WORKFLOW_BLOB_REF_PREFIX.length)
}

export async function storeWorkflowBlob(
  input: StoreWorkflowBlobInput
): Promise<WorkflowBlobHandle> {
  if (!input.accountId) {
    throw new WorkflowBlobError("no-account", "A run without an account cannot store a blob")
  }
  if (input.bytes.byteLength === 0) {
    throw new WorkflowBlobError("empty", "Refusing to store an empty blob")
  }
  if (input.bytes.byteLength > WORKFLOW_BLOB_MAX_BYTES) {
    throw new WorkflowBlobError(
      "too-large",
      `This artifact is ${input.bytes.byteLength} bytes, over the ${WORKFLOW_BLOB_MAX_BYTES}-byte ` +
        `run-scoped limit. Write it to the workspace with a file node instead.`
    )
  }

  const now = input.now ?? Date.now()
  const id = `wfb_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  const key = await loadOrCreateAccountArtifactKey(input.accountId, "workflow-blob")
  const envelope = await encryptAccountArtifactBytes(
    key,
    input.bytes,
    additionalData({ accountId: input.accountId, runId: input.runId, stepId: input.stepId, id })
  )

  const row: WorkflowBlobRow = {
    id,
    accountId: input.accountId,
    runId: input.runId,
    stepId: input.stepId,
    mediaType: input.mediaType,
    size: input.bytes.byteLength,
    ...(input.width !== undefined ? { width: input.width } : {}),
    ...(input.height !== undefined ? { height: input.height } : {}),
    envelope,
    createdAt: now,
    expiresAt: now + WORKFLOW_BLOB_TTL_MS,
  }
  await getDb().workflowBlobs.put(row)

  return {
    blobRef: `${WORKFLOW_BLOB_REF_PREFIX}${id}`,
    mediaType: row.mediaType,
    byteLength: row.size,
    ...(row.width !== undefined ? { width: row.width } : {}),
    ...(row.height !== undefined ? { height: row.height } : {}),
  }
}

export interface OpenWorkflowBlobResult {
  bytes: Uint8Array
  mediaType: string
  width?: number
  height?: number
}

export async function openWorkflowBlob(
  ref: string,
  now: number = Date.now()
): Promise<OpenWorkflowBlobResult> {
  const row = await getDb().workflowBlobs.get(workflowBlobId(ref))
  if (!row) throw new WorkflowBlobError("not-found", `No workflow blob for ${ref}`)
  // Checked here as well as by the sweeper: a row past its TTL is not content
  // a later run may read back just because nobody has pruned it yet.
  if (row.expiresAt <= now) {
    throw new WorkflowBlobError("expired", `The workflow blob ${ref} has expired`)
  }
  const key = await loadOrCreateAccountArtifactKey(row.accountId, "workflow-blob")
  const bytes = await decryptAccountArtifactBytes(
    key,
    rehydrateEnvelope(row.envelope),
    additionalData(row)
  )
  return {
    bytes,
    mediaType: row.mediaType,
    ...(row.width !== undefined ? { width: row.width } : {}),
    ...(row.height !== undefined ? { height: row.height } : {}),
  }
}

/**
 * Put the envelope's byte arrays back into `Uint8Array`.
 *
 * A structured clone through IndexedDB is supposed to preserve the class, and
 * a real browser does. It is not worth trusting for the one read path that
 * decides whether a run's artifact is readable at all: the crypto layer reads
 * `.buffer`, and an object that merely looks like an array throws a
 * `TypeError` deep inside AES-GCM rather than reporting a corrupt row.
 */
function rehydrateEnvelope(envelope: WorkflowBlobRow["envelope"]): WorkflowBlobRow["envelope"] {
  const toBytes = (value: Uint8Array): Uint8Array =>
    value instanceof Uint8Array
      ? value
      : Uint8Array.from(Object.values(value as object) as number[])
  return { ...envelope, iv: toBytes(envelope.iv), ciphertext: toBytes(envelope.ciphertext) }
}

/** Drop every blob past its TTL. Returns how many rows went. */
export async function pruneWorkflowBlobs(now: number = Date.now()): Promise<number> {
  const expired = await getDb().workflowBlobs.where("expiresAt").belowOrEqual(now).primaryKeys()
  if (expired.length === 0) return 0
  await getDb().workflowBlobs.bulkDelete(expired)
  return expired.length
}

// Deliberately no run-teardown delete. These rows outlive their run on purpose:
// a finished run's outputs name them, and the Runs UI has to be able to open
// one afterwards. The TTL and the central sweep own their end of life.
