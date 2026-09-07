/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

const loadKey = jest.fn(async (..._a: unknown[]) => new Uint8Array(32).fill(7))
jest.mock("@/lib/ai/eval/artifact-crypto", () => {
  const actual = jest.requireActual("@/lib/ai/eval/artifact-crypto")
  return { ...actual, loadOrCreateAccountArtifactKey: (...a: unknown[]) => loadKey(...a) }
})

import {
  openWorkflowBlob,
  pruneWorkflowBlobs,
  storeWorkflowBlob,
  WorkflowBlobError,
  isWorkflowBlobRef,
} from "./store"
import { WORKFLOW_BLOB_MAX_BYTES, WORKFLOW_BLOB_TTL_MS } from "@/types/workflow/blob"

const bytes = new Uint8Array([1, 2, 3, 4, 5])

beforeEach(async () => {
  jest.clearAllMocks()
  const { getDb } = await import("@/lib/db/schema")
  await getDb().workflowBlobs.clear()
})

describe("storeWorkflowBlob", () => {
  it("round-trips the bytes and the dimensions", async () => {
    const handle = await storeWorkflowBlob({
      accountId: "acc1",
      runId: "run1",
      stepId: "s1",
      bytes,
      mediaType: "image/png",
      width: 4,
      height: 2,
    })
    expect(isWorkflowBlobRef(handle.blobRef)).toBe(true)
    expect(handle).toMatchObject({ mediaType: "image/png", byteLength: 5, width: 4, height: 2 })

    const opened = await openWorkflowBlob(handle.blobRef)
    expect(Array.from(opened.bytes)).toEqual([1, 2, 3, 4, 5])
    expect(opened).toMatchObject({ mediaType: "image/png", width: 4, height: 2 })
  })

  it("uses the workflow-blob key domain rather than borrowing another one", async () => {
    await storeWorkflowBlob({
      accountId: "acc1",
      runId: "run1",
      stepId: "s1",
      bytes,
      mediaType: "image/png",
    })
    expect(loadKey).toHaveBeenCalledWith("acc1", "workflow-blob")
  })

  it("refuses an oversized artifact and says where it belongs instead", async () => {
    await expect(
      storeWorkflowBlob({
        accountId: "acc1",
        runId: "run1",
        stepId: "s1",
        bytes: new Uint8Array(WORKFLOW_BLOB_MAX_BYTES + 1),
        mediaType: "video/mp4",
      })
    ).rejects.toThrow(/Write it to the workspace with a file node instead/)
  })

  it("refuses an empty blob and a run with no account", async () => {
    await expect(
      storeWorkflowBlob({
        accountId: "acc1",
        runId: "r",
        stepId: "s",
        bytes: new Uint8Array(0),
        mediaType: "image/png",
      })
    ).rejects.toBeInstanceOf(WorkflowBlobError)
    await expect(
      storeWorkflowBlob({ accountId: "", runId: "r", stepId: "s", bytes, mediaType: "image/png" })
    ).rejects.toThrow(/without an account/)
  })
})

describe("openWorkflowBlob", () => {
  it("fails to decrypt a row moved to another run or step", async () => {
    // The AAD binds the ciphertext to its exact run, step and id, so a row
    // relabelled by hand does not read back as content.
    const handle = await storeWorkflowBlob({
      accountId: "acc1",
      runId: "run1",
      stepId: "s1",
      bytes,
      mediaType: "image/png",
    })
    const { getDb } = await import("@/lib/db/schema")
    const id = handle.blobRef.split(":")[1]
    await getDb().workflowBlobs.update(id, { runId: "run2" })
    await expect(openWorkflowBlob(handle.blobRef)).rejects.toThrow()
  })

  it("refuses a reference that is not there, and one past its TTL", async () => {
    await expect(openWorkflowBlob("cognia-workflow-blob:nope")).rejects.toThrow(/No workflow blob/)

    const handle = await storeWorkflowBlob({
      accountId: "acc1",
      runId: "run1",
      stepId: "s1",
      bytes,
      mediaType: "image/png",
      now: 1000,
    })
    // A row past its TTL is not content a later run may read just because
    // nobody has swept it yet.
    await expect(openWorkflowBlob(handle.blobRef, 1000 + WORKFLOW_BLOB_TTL_MS + 1)).rejects.toThrow(
      /has expired/
    )
  })
})

describe("pruneWorkflowBlobs", () => {
  it("removes only rows past their expiry", async () => {
    await storeWorkflowBlob({
      accountId: "acc1",
      runId: "old",
      stepId: "s",
      bytes,
      mediaType: "image/png",
      now: 1000,
    })
    await storeWorkflowBlob({
      accountId: "acc1",
      runId: "new",
      stepId: "s",
      bytes,
      mediaType: "image/png",
      now: 10_000,
    })
    const removed = await pruneWorkflowBlobs(1000 + WORKFLOW_BLOB_TTL_MS + 1)
    expect(removed).toBe(1)
    const { getDb } = await import("@/lib/db/schema")
    expect(await getDb().workflowBlobs.count()).toBe(1)
  })

  it("is a no-op when nothing has expired", async () => {
    await storeWorkflowBlob({
      accountId: "acc1",
      runId: "r",
      stepId: "s",
      bytes,
      mediaType: "image/png",
    })
    expect(await pruneWorkflowBlobs(Date.now())).toBe(0)
  })
})
