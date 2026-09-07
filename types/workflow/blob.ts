/**
 * Run-scoped encrypted binary artifacts for workflow steps.
 *
 * Two node families produce bytes with no file path: `action.media.frame`
 * pulls a single frame out of a video, and every `action.image.*` node encodes
 * a new image. Putting either in a step output would poison the run log:
 * `appendEvent` writes `payload` into `workflowRunEvents` verbatim with no
 * truncation, and the Runs UI live-queries it. `action.artifact.export` already
 * base64s a rendered PNG into a step output, and that is the cautionary
 * precedent rather than the pattern to copy.
 *
 * Modelled on `WorkflowHumanInputFileRow`, which is the existing encrypted,
 * account-keyed, TTL'd blob table. Not on `workflowKnowledgeArtifacts`, whose
 * envelope is string-only (a 33% base64 tax on binary) and whose `stage` union
 * is knowledge-pipeline specific.
 */

/** The `blobRef` string a step output carries in place of the bytes. */
export const WORKFLOW_BLOB_REF_PREFIX = "cognia-workflow-blob:"

/** Bytes larger than this belong in the workspace, not in a run-scoped row. */
export const WORKFLOW_BLOB_MAX_BYTES = 32 * 1024 * 1024

/** How long a run's blobs outlive it. Matches the human-input artifact TTL. */
export const WORKFLOW_BLOB_TTL_MS = 24 * 60 * 60 * 1000

export interface WorkflowBlobRow {
  id: string
  accountId: string
  runId: string
  stepId: string
  mediaType: string
  size: number
  /** Present for images. Absent for anything the producer could not measure. */
  width?: number
  height?: number
  envelope: {
    version: "cognia-account-artifact/v1"
    algorithm: "AES-GCM"
    iv: Uint8Array
    ciphertext: Uint8Array
  }
  createdAt: number
  expiresAt: number
}

/** What a producing node puts in its output in place of the bytes. */
export interface WorkflowBlobHandle {
  blobRef: string
  mediaType: string
  byteLength: number
  width?: number
  height?: number
}
