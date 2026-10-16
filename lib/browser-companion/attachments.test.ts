/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { resolveAttachmentRef } from "@/lib/db/session-attachment-uploads"

import {
  BROWSER_COMPANION_HOST_DEVICE,
  abortBrowserAttachmentUpload,
  commitBrowserAttachmentUpload,
  decodeStrictBase64,
  initBrowserAttachmentUpload,
  resolveBrowserAttachments,
  stagedAttachmentName,
  stagingSessionId,
  writeBrowserAttachmentChunk,
} from "./attachments"

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function pngBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set(PNG_HEADER)
  for (let index = PNG_HEADER.length; index < size; index++) bytes[index] = index % 251
  return bytes
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const { sha256Bytes } = await import("@/lib/ocr/hash")
  return sha256Bytes(bytes)
}

async function stage(deviceId: string, submissionId: string, bytes = pngBytes(64)) {
  const init = await initBrowserAttachmentUpload(deviceId, {
    submissionId,
    name: "Visible area.png",
    mediaType: "image/png",
    kind: "screenshot",
    size: bytes.byteLength,
    hash: await sha256Hex(bytes),
  })
  for (let offset = init.receivedBytes; offset < bytes.byteLength; offset += init.chunkSize) {
    await writeBrowserAttachmentChunk(deviceId, {
      uploadId: init.uploadId,
      offset,
      dataBase64: toBase64(bytes.subarray(offset, offset + init.chunkSize)),
    })
  }
  const committed = await commitBrowserAttachmentUpload(deviceId, { uploadId: init.uploadId })
  return { init, committed }
}

beforeEach(async () => {
  __resetDbForTesting()
  await whenSeeded()
  await getDb().sessionAttachmentUploads.clear()
})

describe("browser attachment staging", () => {
  it("stages under the Host's caller and the submission's placeholder session", async () => {
    const { init, committed } = await stage("browser-a", "sub-1")
    expect(committed.attachmentId).toBe(init.uploadId)
    const row = await getDb().sessionAttachmentUploads.get(init.uploadId)
    expect(row).toMatchObject({
      deviceId: BROWSER_COMPANION_HOST_DEVICE,
      sessionId: stagingSessionId("browser-a", "sub-1"),
      status: "committed",
      name: "Visible area.png",
    })
  })

  it("resumes the same content rather than staging it twice", async () => {
    const bytes = pngBytes(64)
    await stage("browser-a", "sub-1", bytes)
    const again = await initBrowserAttachmentUpload("browser-a", {
      submissionId: "sub-1",
      name: "Visible area.png",
      mediaType: "image/png",
      kind: "screenshot",
      size: bytes.byteLength,
      hash: await sha256Hex(bytes),
    })
    expect(again.attachmentId).toBe(again.uploadId)
    expect(again.receivedBytes).toBe(bytes.byteLength)
  })

  it("refuses another browser's upload exactly as a missing one", async () => {
    const bytes = pngBytes(64)
    const init = await initBrowserAttachmentUpload("browser-a", {
      submissionId: "sub-1",
      name: "x.png",
      mediaType: "image/png",
      kind: "image",
      size: bytes.byteLength,
      hash: await sha256Hex(bytes),
    })
    await expect(
      writeBrowserAttachmentChunk("browser-b", {
        uploadId: init.uploadId,
        offset: 0,
        dataBase64: toBase64(bytes),
      })
    ).rejects.toMatchObject({ code: "attachment_not_found" })
    await expect(
      commitBrowserAttachmentUpload("browser-b", { uploadId: init.uploadId })
    ).rejects.toMatchObject({ code: "attachment_not_found" })
    // Abort is silent for someone else's upload, and leaves it alone.
    await expect(
      abortBrowserAttachmentUpload("browser-b", { uploadId: init.uploadId })
    ).resolves.toBeNull()
    expect(await getDb().sessionAttachmentUploads.get(init.uploadId)).toBeDefined()
    await abortBrowserAttachmentUpload("browser-a", { uploadId: init.uploadId })
    expect(await getDb().sessionAttachmentUploads.get(init.uploadId)).toBeUndefined()
  })

  it("only accepts the media types a browser can produce", async () => {
    await expect(
      initBrowserAttachmentUpload("browser-a", {
        submissionId: "sub-1",
        name: "notes.txt",
        mediaType: "text/plain",
        kind: "image",
        size: 3,
        hash: "a".repeat(64),
      })
    ).rejects.toMatchObject({ code: "attachment_unsupported_type" })
    await expect(
      initBrowserAttachmentUpload("browser-a", {
        submissionId: "sub-1",
        name: "x.png",
        mediaType: "image/png",
        kind: "video",
        size: 3,
        hash: "a".repeat(64),
      })
    ).rejects.toMatchObject({ code: "malformed" })
  })

  it("refuses an image whose bytes are not one, at commit", async () => {
    const bytes = new TextEncoder().encode("definitely not a png file")
    const init = await initBrowserAttachmentUpload("browser-a", {
      submissionId: "sub-1",
      name: "x.png",
      mediaType: "image/png",
      kind: "image",
      size: bytes.byteLength,
      hash: await sha256Hex(bytes),
    })
    await writeBrowserAttachmentChunk("browser-a", {
      uploadId: init.uploadId,
      offset: 0,
      dataBase64: toBase64(bytes),
    })
    await expect(
      commitBrowserAttachmentUpload("browser-a", { uploadId: init.uploadId })
    ).rejects.toMatchObject({ code: "attachment_type_mismatch" })
  })

  it("binds the attachments to the conversation, and only for their own submission", async () => {
    const { committed } = await stage("browser-a", "sub-1")
    const ref = { attachmentId: committed.attachmentId, kind: "screenshot" as const }
    await expect(
      resolveBrowserAttachments({
        deviceId: "browser-a",
        submissionId: "sub-2",
        sessionId: "session-1",
        attachments: [ref],
      })
    ).rejects.toMatchObject({ code: "unknown_attachment" })
    await expect(
      resolveBrowserAttachments({
        deviceId: "browser-b",
        submissionId: "sub-1",
        sessionId: "session-1",
        attachments: [ref],
      })
    ).rejects.toMatchObject({ code: "unknown_attachment" })

    const staged = await resolveBrowserAttachments({
      deviceId: "browser-a",
      submissionId: "sub-1",
      sessionId: "session-1",
      attachments: [ref],
    })
    expect(staged).toEqual([
      expect.objectContaining({
        name: "Visible area.png",
        mediaType: "image/png",
        kind: "screenshot",
        ref: `cognia-upload:${committed.attachmentId}`,
      }),
    ])
    // HostState's enqueue-time check sees a ref this caller owns in this session.
    expect(
      await resolveAttachmentRef(staged[0]?.ref ?? "", {
        sessionId: "session-1",
        deviceId: BROWSER_COMPANION_HOST_DEVICE,
      })
    ).not.toBeNull()
  })
})

describe("stagedAttachmentName", () => {
  it("keeps a safe name with the extension the media type needs", () => {
    expect(stagedAttachmentName("Pricing — Example.html", "application/pdf")).toBe(
      "Pricing Example.pdf"
    )
    expect(stagedAttachmentName("../../etc/passwd", "image/png")).toBe(".. .. etc passwd.png")
    expect(stagedAttachmentName("", "image/jpeg")).toBe("attachment.jpg")
  })
})

describe("decodeStrictBase64", () => {
  it("refuses rather than truncates malformed input", () => {
    expect([...decodeStrictBase64("AAEC")]).toEqual([0, 1, 2])
    for (const bad of ["", "AAE", "AA E", "@@@@"]) {
      expect(() => decodeStrictBase64(bad)).toThrow(expect.objectContaining({ code: "malformed" }))
    }
  })
})
