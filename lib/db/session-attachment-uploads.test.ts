/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import {
  ATTACHMENT_OBJECT_TTL_MS,
  ATTACHMENT_UPLOAD_TTL_MS,
  AttachmentUploadError,
  abortAttachmentUpload,
  appendAttachmentChunk,
  beginAttachmentUpload,
  commitAttachmentUpload,
  consumeAttachmentRefs,
  parseUploadRef,
  releaseDeviceAttachmentUploads,
  resolveAttachmentRef,
  sniffImageMediaType,
  sweepAttachmentUploads,
} from "./session-attachment-uploads"

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** A PNG-looking payload of `size` bytes. */
function pngBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set(PNG_HEADER.slice(0, Math.min(PNG_HEADER.length, size)))
  for (let index = PNG_HEADER.length; index < size; index++) bytes[index] = index % 251
  return bytes
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const { sha256Bytes } = await import("@/lib/ocr/hash")
  return sha256Bytes(bytes)
}

/** init → chunk* → commit, the whole happy path in one call. */
async function uploadWhole(input: {
  sessionId: string
  deviceId: string
  name?: string
  mediaType?: string
  bytes: Uint8Array
  chunkSize?: number
}) {
  const hash = await sha256(input.bytes)
  const init = await beginAttachmentUpload({
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    name: input.name ?? "shot.png",
    mediaType: input.mediaType ?? "image/png",
    size: input.bytes.byteLength,
    hash,
  })
  const step = input.chunkSize ?? init.chunkSize
  for (let offset = init.resumeOffset; offset < input.bytes.byteLength; offset += step) {
    await appendAttachmentChunk({
      uploadId: init.uploadId,
      deviceId: input.deviceId,
      offset,
      bytes: input.bytes.subarray(offset, Math.min(offset + step, input.bytes.byteLength)),
    })
  }
  return {
    init,
    hash,
    committed: await commitAttachmentUpload({ uploadId: init.uploadId, deviceId: input.deviceId }),
  }
}

beforeEach(async () => {
  __resetDbForTesting()
  await whenSeeded()
  // `__resetDbForTesting` closes the handle; the fake IndexedDB behind it keeps
  // its rows, and this table is the whole subject of the suite.
  await getDb().sessionAttachmentUploads.clear()
})

describe("session attachment uploads", () => {
  it("carries a file across in chunks and mints a ref only once it is whole", async () => {
    const bytes = pngBytes(4096)
    const { init, hash, committed } = await uploadWhole({
      sessionId: "ses-1",
      deviceId: "dev-a",
      bytes,
      chunkSize: 1000,
    })

    expect(init.resumeOffset).toBe(0)
    expect(init.complete).toBe(false)
    expect(parseUploadRef(committed.ref)).toBe(init.uploadId)
    expect(committed.size).toBe(4096)
    expect(committed.hash).toBe(hash)

    const resolved = await resolveAttachmentRef(committed.ref, { sessionId: "ses-1" })
    expect(resolved?.bytes).toEqual(bytes)
  })

  it("resumes from the host's write head instead of restarting the file", async () => {
    const bytes = pngBytes(3000)
    const hash = await sha256(bytes)
    const first = await beginAttachmentUpload({
      sessionId: "ses-1",
      deviceId: "dev-a",
      name: "shot.png",
      mediaType: "image/png",
      size: bytes.byteLength,
      hash,
    })
    await appendAttachmentChunk({
      uploadId: first.uploadId,
      deviceId: "dev-a",
      offset: 0,
      bytes: bytes.subarray(0, 1200),
    })

    // The client's process died here; it re-inits the same content.
    const rejoin = await beginAttachmentUpload({
      sessionId: "ses-1",
      deviceId: "dev-a",
      name: "shot.png",
      mediaType: "image/png",
      size: bytes.byteLength,
      hash,
    })
    expect(rejoin.uploadId).toBe(first.uploadId)
    expect(rejoin.resumeOffset).toBe(1200)
    expect(rejoin.complete).toBe(false)
  })

  it("answers a re-init of already-committed content without another transfer", async () => {
    const bytes = pngBytes(512)
    const { init, hash } = await uploadWhole({ sessionId: "ses-1", deviceId: "dev-a", bytes })

    const again = await beginAttachmentUpload({
      sessionId: "ses-1",
      deviceId: "dev-a",
      name: "shot.png",
      mediaType: "image/png",
      size: bytes.byteLength,
      hash,
    })
    expect(again.uploadId).toBe(init.uploadId)
    expect(again.complete).toBe(true)
    expect(again.resumeOffset).toBe(bytes.byteLength)
    expect(parseUploadRef(again.ref ?? "")).toBe(init.uploadId)
  })

  it("treats a re-sent chunk as a no-op but refuses a real gap", async () => {
    const bytes = pngBytes(900)
    const hash = await sha256(bytes)
    const init = await beginAttachmentUpload({
      sessionId: "ses-1",
      deviceId: "dev-a",
      name: "shot.png",
      mediaType: "image/png",
      size: bytes.byteLength,
      hash,
    })
    await appendAttachmentChunk({
      uploadId: init.uploadId,
      deviceId: "dev-a",
      offset: 0,
      bytes: bytes.subarray(0, 300),
    })
    // Response was lost in flight; the client retries the same chunk.
    const replay = await appendAttachmentChunk({
      uploadId: init.uploadId,
      deviceId: "dev-a",
      offset: 0,
      bytes: bytes.subarray(0, 300),
    })
    expect(replay.receivedBytes).toBe(300)

    await expect(
      appendAttachmentChunk({
        uploadId: init.uploadId,
        deviceId: "dev-a",
        offset: 600,
        bytes: bytes.subarray(600, 900),
      })
    ).rejects.toMatchObject({ code: "attachment_offset_mismatch" })
  })

  it("refuses to commit bytes that do not match the declared hash", async () => {
    const bytes = pngBytes(256)
    const hash = await sha256(pngBytes(255))
    const init = await beginAttachmentUpload({
      sessionId: "ses-1",
      deviceId: "dev-a",
      name: "shot.png",
      mediaType: "image/png",
      size: bytes.byteLength,
      hash,
    })
    await appendAttachmentChunk({
      uploadId: init.uploadId,
      deviceId: "dev-a",
      offset: 0,
      bytes,
    })
    await expect(
      commitAttachmentUpload({ uploadId: init.uploadId, deviceId: "dev-a" })
    ).rejects.toMatchObject({ code: "attachment_hash_mismatch" })
  })

  it("refuses a declared image whose bytes are not an image", async () => {
    const bytes = new TextEncoder().encode("#!/bin/sh\nrm -rf /\n")
    const hash = await sha256(bytes)
    const init = await beginAttachmentUpload({
      sessionId: "ses-1",
      deviceId: "dev-a",
      name: "payload.png",
      mediaType: "image/png",
      size: bytes.byteLength,
      hash,
    })
    await appendAttachmentChunk({ uploadId: init.uploadId, deviceId: "dev-a", offset: 0, bytes })
    await expect(
      commitAttachmentUpload({ uploadId: init.uploadId, deviceId: "dev-a" })
    ).rejects.toMatchObject({ code: "attachment_type_mismatch" })
  })

  it("corrects a mislabelled image rather than refusing it", async () => {
    const bytes = new Uint8Array(64)
    bytes.set([0xff, 0xd8, 0xff])
    const { committed } = await uploadWhole({
      sessionId: "ses-1",
      deviceId: "dev-a",
      name: "photo.png",
      mediaType: "image/png",
      bytes,
    })
    expect(committed.mediaType).toBe("image/jpeg")
  })

  it("refuses a type the desktop composer would not stage either", async () => {
    await expect(
      beginAttachmentUpload({
        sessionId: "ses-1",
        deviceId: "dev-a",
        name: "installer.dmg",
        mediaType: "application/octet-stream",
        size: 10,
        hash: "a".repeat(64),
      })
    ).rejects.toMatchObject({ code: "attachment_unsupported_type" })
  })

  it("refuses a file above the ceiling and a malformed hash", async () => {
    await expect(
      beginAttachmentUpload({
        sessionId: "ses-1",
        deviceId: "dev-a",
        name: "big.png",
        mediaType: "image/png",
        size: 999_999_999,
        hash: "b".repeat(64),
      })
    ).rejects.toMatchObject({ code: "attachment_too_large" })

    await expect(
      beginAttachmentUpload({
        sessionId: "ses-1",
        deviceId: "dev-a",
        name: "ok.png",
        mediaType: "image/png",
        size: 10,
        hash: "not-a-hash",
      })
    ).rejects.toMatchObject({ code: "attachment_invalid_hash" })
  })

  it("caps how many files one device may stage against one session", async () => {
    for (let index = 0; index < 6; index++) {
      await beginAttachmentUpload({
        sessionId: "ses-1",
        deviceId: "dev-a",
        name: `shot-${index}.png`,
        mediaType: "image/png",
        size: 16,
        hash: await sha256(pngBytes(16 + index)),
      })
    }
    await expect(
      beginAttachmentUpload({
        sessionId: "ses-1",
        deviceId: "dev-a",
        name: "seventh.png",
        mediaType: "image/png",
        size: 16,
        hash: await sha256(pngBytes(99)),
      })
    ).rejects.toMatchObject({ code: "attachment_too_many" })

    // A different session has its own staging area — the ceiling is per
    // message, not a global budget the whole device shares.
    await expect(
      beginAttachmentUpload({
        sessionId: "ses-2",
        deviceId: "dev-a",
        name: "elsewhere.png",
        mediaType: "image/png",
        size: 16,
        hash: await sha256(pngBytes(101)),
      })
    ).resolves.toMatchObject({ resumeOffset: 0 })
  })

  it("hides one device's upload from another, holding the id or not", async () => {
    const bytes = pngBytes(128)
    const { init, committed } = await uploadWhole({
      sessionId: "ses-1",
      deviceId: "dev-a",
      bytes,
    })

    await expect(
      appendAttachmentChunk({
        uploadId: init.uploadId,
        deviceId: "dev-b",
        offset: 0,
        bytes,
      })
    ).rejects.toMatchObject({ code: "attachment_not_found" })
    await expect(
      commitAttachmentUpload({ uploadId: init.uploadId, deviceId: "dev-b" })
    ).rejects.toMatchObject({ code: "attachment_not_found" })
    expect(
      await resolveAttachmentRef(committed.ref, { sessionId: "ses-1", deviceId: "dev-b" })
    ).toBeNull()
    // Aborting someone else's upload must not destroy it either.
    await abortAttachmentUpload({ uploadId: init.uploadId, deviceId: "dev-b" })
    expect(await resolveAttachmentRef(committed.ref, { sessionId: "ses-1" })).not.toBeNull()
  })

  it("will not let a ref be redirected into a different session", async () => {
    const { committed } = await uploadWhole({
      sessionId: "ses-1",
      deviceId: "dev-a",
      bytes: pngBytes(64),
    })
    expect(await resolveAttachmentRef(committed.ref, { sessionId: "ses-2" })).toBeNull()
  })

  it("releases the bytes once the runtime has the file, keeping the spend record", async () => {
    const { init, committed } = await uploadWhole({
      sessionId: "ses-1",
      deviceId: "dev-a",
      bytes: pngBytes(64),
    })
    await consumeAttachmentRefs([committed.ref])

    const row = await getDb().sessionAttachmentUploads.get(init.uploadId)
    expect(row?.consumedAt).toEqual(expect.any(Number))
    expect(row?.bytes).toBeUndefined()
    // A consumed row no longer counts as staged, so the next message starts
    // from an empty staging area rather than one slot down.
    expect(await resolveAttachmentRef(committed.ref, { sessionId: "ses-1" })).toBeNull()
  })

  it("collects an abandoned upload but not one a message already spent", async () => {
    const abandoned = await beginAttachmentUpload({
      sessionId: "ses-1",
      deviceId: "dev-a",
      name: "abandoned.png",
      mediaType: "image/png",
      size: 32,
      hash: await sha256(pngBytes(32)),
    })
    const { init, committed } = await uploadWhole({
      sessionId: "ses-1",
      deviceId: "dev-a",
      bytes: pngBytes(48),
    })
    await consumeAttachmentRefs([committed.ref])

    const collected = await sweepAttachmentUploads(Date.now() + ATTACHMENT_UPLOAD_TTL_MS + 1)
    expect(collected).toBe(1)
    expect(await getDb().sessionAttachmentUploads.get(abandoned.uploadId)).toBeUndefined()
    expect(await getDb().sessionAttachmentUploads.get(init.uploadId)).toBeDefined()
  })

  it("keeps a committed object alive far longer than a half-finished one", async () => {
    const { init } = await uploadWhole({
      sessionId: "ses-1",
      deviceId: "dev-a",
      bytes: pngBytes(64),
    })
    // A client that committed but has not managed to send yet: still there
    // well past the upload TTL, because the pause is recoverable and losing
    // the file is not.
    await sweepAttachmentUploads(Date.now() + ATTACHMENT_UPLOAD_TTL_MS + 1)
    expect(await getDb().sessionAttachmentUploads.get(init.uploadId)).toBeDefined()

    await sweepAttachmentUploads(Date.now() + ATTACHMENT_OBJECT_TTL_MS + 1)
    expect(await getDb().sessionAttachmentUploads.get(init.uploadId)).toBeUndefined()
  })

  it("drops everything a revoked device staged, and nothing anyone else did", async () => {
    const mine = await uploadWhole({ sessionId: "ses-1", deviceId: "dev-a", bytes: pngBytes(32) })
    const theirs = await uploadWhole({ sessionId: "ses-1", deviceId: "dev-b", bytes: pngBytes(33) })

    expect(await releaseDeviceAttachmentUploads("dev-a")).toBe(1)
    expect(await resolveAttachmentRef(mine.committed.ref, { sessionId: "ses-1" })).toBeNull()
    expect(await resolveAttachmentRef(theirs.committed.ref, { sessionId: "ses-1" })).not.toBeNull()
  })

  it("is idempotent on commit so a retried response cannot fail the send", async () => {
    const { init, committed } = await uploadWhole({
      sessionId: "ses-1",
      deviceId: "dev-a",
      bytes: pngBytes(64),
    })
    const again = await commitAttachmentUpload({ uploadId: init.uploadId, deviceId: "dev-a" })
    expect(again).toEqual(committed)
  })

  it("refuses to resolve a ref that is not one", async () => {
    expect(parseUploadRef("cognia-media:abc")).toBeNull()
    expect(parseUploadRef("cognia-upload:")).toBeNull()
    expect(await resolveAttachmentRef("/etc/passwd", { sessionId: "ses-1" })).toBeNull()
  })
})

describe("image sniffing", () => {
  it.each([
    ["png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
    ["jpeg", [0xff, 0xd8, 0xff, 0xe0], "image/jpeg"],
    ["gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], "image/gif"],
    ["bmp", [0x42, 0x4d, 0x00, 0x00], "image/bmp"],
  ])("recognizes %s", (_label, prefix, expected) => {
    const bytes = new Uint8Array(32)
    bytes.set(prefix)
    expect(sniffImageMediaType(bytes)).toBe(expected)
  })

  it("recognizes container formats by their brand, not their extension", () => {
    const webp = new Uint8Array(16)
    webp.set([0x52, 0x49, 0x46, 0x46])
    webp.set([0x57, 0x45, 0x42, 0x50], 8)
    expect(sniffImageMediaType(webp)).toBe("image/webp")

    const heic = new Uint8Array(16)
    heic.set([0x66, 0x74, 0x79, 0x70], 4)
    heic.set([0x68, 0x65, 0x69, 0x63], 8)
    expect(sniffImageMediaType(heic)).toBe("image/heic")
  })

  it("returns null for anything it does not recognize, including a short buffer", () => {
    expect(sniffImageMediaType(new Uint8Array([0x89]))).toBeNull()
    expect(sniffImageMediaType(new TextEncoder().encode("plain text"))).toBeNull()
  })
})

describe("AttachmentUploadError", () => {
  it("carries a machine-readable code the RPC layer can forward", () => {
    const error = new AttachmentUploadError("attachment_too_many")
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe("attachment_too_many")
    expect(error.message).toBe("attachment_too_many")
  })
})
