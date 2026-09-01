/**
 * Runs in the `node` project deliberately.
 *
 * jsdom's structured clone turns a `Uint8Array` into a plain object on the way
 * back out of `fake-indexeddb`, which would have made the persisted bytes
 * untestable and left the queue's most important field unverified. Node's
 * clone round-trips them, and everything else this suite needs (`Blob`,
 * `atob`) has been global there since Node 18.
 */
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  __resetSftpTransferRuntimeForTests,
  cancelSftpTransfer,
  clearFinishedSftpTransfers,
  currentSftpTransferApproval,
  enqueueSftpDownload,
  enqueueSftpUpload,
  pauseSftpTransfer,
  resumeSftpTransfer,
  retrySftpTransfer,
  SFTP_APPROVAL_REQUIRED,
  SFTP_MAX_QUEUED_BYTES,
  setSftpTransferApproval,
  SftpTransferTooLargeError,
  startSftpTransferPump,
} from "./transfer-queue"

const downloadSftpFile = jest.fn()
const uploadSftpFile = jest.fn()

jest.mock("./client", () => {
  class SftpTransferAbortedError extends Error {
    constructor() {
      super("the transfer was cancelled")
      this.name = "SftpTransferAbortedError"
    }
  }
  return {
    SftpTransferAbortedError,
    downloadSftpFile: (...args: unknown[]) => downloadSftpFile(...args),
    uploadSftpFile: (...args: unknown[]) => uploadSftpFile(...args),
  }
})

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  __resetSftpTransferRuntimeForTests()
  downloadSftpFile.mockReset()
  uploadSftpFile.mockReset()
})
afterAll(dbFixture.dispose)

async function drain(stop: () => void, until: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await until()) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  stop()
}

const row = (id: string) => getDb().sftpTransfers.get(id)

describe("enqueue", () => {
  it("takes the file name from the remote path and starts at zero", async () => {
    const id = await enqueueSftpDownload({
      profileId: "production",
      profileLabel: "Production",
      remotePath: "/var/log/app.log",
      size: 512,
    })
    expect(await row(id)).toMatchObject({
      fileName: "app.log",
      direction: "download",
      status: "queued",
      transferred: 0,
      size: 512,
    })
  })

  /**
   * The bytes ride with the row on purpose. A queue that stored only a path
   * would describe an upload it can no longer perform after a reload, which is
   * the failure the persistence exists to prevent.
   */
  it("keeps the upload payload so a restart still has something to send", async () => {
    const id = await enqueueSftpUpload({
      profileId: "production",
      profileLabel: "Production",
      remotePath: "/srv/app/bundle.tar",
      body: new Blob([new Uint8Array([1, 2, 3])]),
    })
    const stored = await row(id)
    expect(stored?.size).toBe(3)
    // Bytes, not a `Blob`. A `Blob` comes back from `fake-indexeddb` as `{}`,
    // which would have left the field the whole queue depends on unverified.
    expect(stored?.payload).toEqual(new Uint8Array([1, 2, 3]))
  })

  /**
   * Durability is what forces the limit, so the refusal names it rather than
   * accepting the file and dying between a structured clone and a quota.
   */
  it("refuses a file it could not hold the bytes for", async () => {
    const oversized = new Blob([new Uint8Array(4)])
    Object.defineProperty(oversized, "size", { value: SFTP_MAX_QUEUED_BYTES + 1 })
    await expect(
      enqueueSftpUpload({
        profileId: "production",
        profileLabel: "Production",
        remotePath: "/srv/huge.iso",
        body: oversized,
      })
    ).rejects.toBeInstanceOf(SftpTransferTooLargeError)
    expect(await getDb().sftpTransfers.count()).toBe(0)
  })
})

describe("the pump", () => {
  it("runs a queued download and records what came back", async () => {
    downloadSftpFile.mockResolvedValue(new Blob([new Uint8Array([1, 2, 3, 4])]))
    const id = await enqueueSftpDownload({
      profileId: "production",
      profileLabel: "Production",
      remotePath: "/var/log/app.log",
      size: 4,
    })
    const stop = startSftpTransferPump({ requiresApproval: false, pollIntervalMs: 50 })
    await drain(stop, async () => (await row(id))?.status === "done")
    expect(await row(id)).toMatchObject({ status: "done", transferred: 4 })
    expect((await row(id))?.received).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  /**
   * A remote shell parks rather than fails. "Nobody has approved this yet" and
   * "the machine refused you" are different answers, and reporting the first as
   * the second sends the user looking for a permissions problem on a box that
   * never heard from them.
   */
  it("parks a transfer nobody has approved instead of failing it", async () => {
    const id = await enqueueSftpDownload({
      profileId: "production",
      profileLabel: "Production",
      remotePath: "/var/log/app.log",
      size: 4,
    })
    const stop = startSftpTransferPump({ requiresApproval: true, pollIntervalMs: 50 })
    await drain(stop, async () => (await row(id))?.status === "paused")
    expect(await row(id)).toMatchObject({
      status: "paused",
      errorCode: SFTP_APPROVAL_REQUIRED,
    })
    expect(downloadSftpFile).not.toHaveBeenCalled()
  })

  it("runs once an approval is in hand", async () => {
    downloadSftpFile.mockResolvedValue(new Blob([new Uint8Array([1])]))
    setSftpTransferApproval("lease-1")
    const id = await enqueueSftpDownload({
      profileId: "production",
      profileLabel: "Production",
      remotePath: "/var/log/app.log",
      size: 1,
    })
    const stop = startSftpTransferPump({ requiresApproval: true, pollIntervalMs: 50 })
    await drain(stop, async () => (await row(id))?.status === "done")
    expect(downloadSftpFile).toHaveBeenCalledWith(
      "production",
      "/var/log/app.log",
      expect.objectContaining({ adminLease: "lease-1" })
    )
  })

  /**
   * A row left `running` by a process that is gone is not running. Leaving the
   * status alone would show a progress bar that can never move and would keep
   * the pump from ever picking the row up again.
   */
  it("parks a transfer the previous process left running", async () => {
    const id = await enqueueSftpDownload({
      profileId: "production",
      profileLabel: "Production",
      remotePath: "/var/log/app.log",
      size: 4,
    })
    await getDb().sftpTransfers.update(id, { status: "running" })
    const stop = startSftpTransferPump({ requiresApproval: true, pollIntervalMs: 50 })
    await drain(stop, async () => (await row(id))?.status === "paused")
    expect(await row(id)).toMatchObject({ status: "paused" })
  })

  it("keeps the machine's own words when a transfer fails", async () => {
    downloadSftpFile.mockRejectedValue(new Error("sftp_operation_failed: Permission denied"))
    const id = await enqueueSftpDownload({
      profileId: "production",
      profileLabel: "Production",
      remotePath: "/etc/shadow",
      size: 1,
    })
    const stop = startSftpTransferPump({ requiresApproval: false, pollIntervalMs: 50 })
    await drain(stop, async () => (await row(id))?.status === "failed")
    expect(await row(id)).toMatchObject({
      status: "failed",
      errorCode: "sftp_operation_failed",
      errorMessage: "Permission denied",
    })
  })

  /**
   * An upload the machine accepted only part of is not done. Reporting it as
   * done would leave a truncated file on a production box looking like a
   * finished deploy.
   */
  it("refuses to call a short upload finished", async () => {
    uploadSftpFile.mockResolvedValue({
      path: "/srv/app/bundle.tar",
      size: 2,
      declaredSize: 3,
      complete: false,
    })
    const id = await enqueueSftpUpload({
      profileId: "production",
      profileLabel: "Production",
      remotePath: "/srv/app/bundle.tar",
      body: new Blob([new Uint8Array([1, 2, 3])]),
    })
    const stop = startSftpTransferPump({ requiresApproval: false, pollIntervalMs: 50 })
    await drain(stop, async () => (await row(id))?.status === "failed")
    expect(await row(id)).toMatchObject({ status: "failed", errorCode: "sftp_incomplete" })
  })

  it("says so when the bytes to upload are no longer held", async () => {
    const id = await enqueueSftpUpload({
      profileId: "production",
      profileLabel: "Production",
      remotePath: "/srv/app/bundle.tar",
      body: new Blob([new Uint8Array([1])]),
    })
    await getDb().sftpTransfers.update(id, { payload: undefined })
    const stop = startSftpTransferPump({ requiresApproval: false, pollIntervalMs: 50 })
    await drain(stop, async () => (await row(id))?.status === "failed")
    expect(await row(id)).toMatchObject({ errorCode: "sftp_payload_missing" })
    expect(uploadSftpFile).not.toHaveBeenCalled()
  })
})

describe("controls", () => {
  it("resuming clears the reason the row stopped", async () => {
    const id = await enqueueSftpDownload({
      profileId: "production",
      profileLabel: "Production",
      remotePath: "/a",
      size: 1,
    })
    await getDb().sftpTransfers.update(id, {
      status: "paused",
      errorCode: SFTP_APPROVAL_REQUIRED,
      errorMessage: "needs approval",
    })
    await resumeSftpTransfer(id)
    expect(await row(id)).toMatchObject({ status: "queued", errorCode: null, errorMessage: null })
  })

  /**
   * A cancelled transfer drops what it received. Keeping it would leave the
   * largest thing in the row behind for a resume that is not coming.
   */
  it("cancelling drops the partial bytes, pausing keeps them", async () => {
    const id = await enqueueSftpDownload({
      profileId: "production",
      profileLabel: "Production",
      remotePath: "/a",
      size: 4,
    })
    await getDb().sftpTransfers.update(id, { received: new Uint8Array([1, 2]) })
    await pauseSftpTransfer(id)
    expect((await row(id))?.received).toEqual(new Uint8Array([1, 2]))
    await cancelSftpTransfer(id)
    expect(await row(id)).toMatchObject({ status: "cancelled" })
    expect((await row(id))?.received).toBeUndefined()
  })

  it("retrying starts over rather than resuming a truncated read", async () => {
    const id = await enqueueSftpDownload({
      profileId: "production",
      profileLabel: "Production",
      remotePath: "/a",
      size: 4,
    })
    await getDb().sftpTransfers.update(id, {
      status: "failed",
      transferred: 2,
      received: new Uint8Array([1, 2]),
      errorCode: "sftp_operation_failed",
    })
    await retrySftpTransfer(id)
    expect(await row(id)).toMatchObject({ status: "queued", transferred: 0, errorCode: null })
    expect((await row(id))?.received).toBeUndefined()
  })

  it("pausing a finished transfer leaves it finished", async () => {
    const id = await enqueueSftpDownload({
      profileId: "production",
      profileLabel: "Production",
      remotePath: "/a",
      size: 1,
    })
    await getDb().sftpTransfers.update(id, { status: "done" })
    await pauseSftpTransfer(id)
    expect(await row(id)).toMatchObject({ status: "done" })
  })

  it("clears only the finished rows, and only for the profile asked about", async () => {
    const done = await enqueueSftpDownload({
      profileId: "production",
      profileLabel: "Production",
      remotePath: "/a",
      size: 1,
    })
    const queued = await enqueueSftpDownload({
      profileId: "production",
      profileLabel: "Production",
      remotePath: "/b",
      size: 1,
    })
    const elsewhere = await enqueueSftpDownload({
      profileId: "staging",
      profileLabel: "Staging",
      remotePath: "/c",
      size: 1,
    })
    await getDb().sftpTransfers.update(done, { status: "done" })
    await getDb().sftpTransfers.update(elsewhere, { status: "done" })

    expect(await clearFinishedSftpTransfers("production")).toBe(1)
    expect(await row(done)).toBeUndefined()
    expect(await row(queued)).toBeDefined()
    expect(await row(elsewhere)).toBeDefined()
  })
})

describe("the approval holder", () => {
  it("forgets a lease that has expired rather than presenting a dead one", () => {
    setSftpTransferApproval("lease-1", Date.now() - 1)
    expect(currentSftpTransferApproval()).toBeNull()
    setSftpTransferApproval("lease-2", Date.now() + 60_000)
    expect(currentSftpTransferApproval()).toBe("lease-2")
  })

  /** The desktop's answer is "none needed", not "none yet". */
  it("treats an absent expiry on a real token as no expiry", () => {
    setSftpTransferApproval("lease-1")
    expect(currentSftpTransferApproval()).toBe("lease-1")
  })
})
