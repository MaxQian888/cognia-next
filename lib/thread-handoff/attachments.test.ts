/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { Blob as NodeBlob } from "node:buffer"
const originalBlob = globalThis.Blob
beforeAll(() => {
  globalThis.Blob = NodeBlob as unknown as typeof Blob
})
afterAll(() => {
  globalThis.Blob = originalBlob
})
import { getDb } from "@/lib/db/schema"
import { sha256Bytes } from "@/lib/ocr/hash"
import { mediaRef, putMessageMedia, type MessageMediaRow } from "@/lib/db/message-media"
import type { CanonicalTurn } from "@cognia/agent-config-types/canonical-session"
import type { ThreadHandoffTicket } from "@cognia/agent-config-types/thread-handoff"
import {
  buildThreadHandoffAttachments,
  receiveThreadHandoffAttachments,
  verifiedThreadHandoffAttachmentRefs,
  stageRemoteThreadHandoffAttachments,
} from "./attachments"

const mockMedia = new Map<string, MessageMediaRow>()
jest.mock("@/lib/db/message-media", () => ({
  ...jest.requireActual("@/lib/db/message-media"),
  getMessageMedia: async (key: string) => mockMedia.get(key.replace("cognia-media:", "")),
  putMessageMedia: async (row: MessageMediaRow) => {
    mockMedia.set(row.hash, row)
    return `cognia-media:${row.hash}`
  },
}))

const bytes = new Uint8Array([1, 2, 3])
const hash = "a".repeat(64)
const ref = mediaRef(hash)
const turns = (): CanonicalTurn[] => [
  {
    turnId: "u",
    role: "user",
    text: "image",
    parts: [{ type: "file", uri: ref, name: "image.png" }],
  },
]
const ticket = (attachments: ThreadHandoffTicket["attachments"]): ThreadHandoffTicket =>
  ({
    ticketId: "ticket",
    source: { sessionId: "source" },
    target: { sessionId: "target" },
    attachments,
  }) as ThreadHandoffTicket
const storeMedia = () =>
  putMessageMedia({
    hash,
    blob: new Blob([bytes], { type: "image/png" }),
    mediaType: "image/png",
    byteSize: 3,
    width: 1,
    height: 1,
    createdAt: 1,
    lastUsedAt: 1,
  })

beforeEach(async () => {
  mockMedia.clear()
  await getDb().sessionAttachmentUploads.clear()
  await getDb().messageMediaRefs.clear()
})

it("deduplicates media and hashes the actual canonical variant, whose original hash can differ", async () => {
  await storeMedia()
  const sequence = [...turns(), ...turns()]
  const manifest = await buildThreadHandoffAttachments(sequence, "source")
  expect(manifest).toHaveLength(1)
  expect(manifest[0]).toMatchObject({
    ref,
    digest: await sha256Bytes(bytes),
    byteLength: 3,
    carriage: "by-ref",
  })
  expect(sequence[0].parts?.[0]).toMatchObject({ digest: manifest[0].digest, size: 3 })
  expect(await verifiedThreadHandoffAttachmentRefs(ticket(manifest))).toEqual([ref])
})

it("does not invent a manifest for inaccessible files or remote URLs", async () => {
  await expect(buildThreadHandoffAttachments(turns(), "source")).rejects.toThrow("unresolvable")
  const sequence = turns()
  sequence[0].parts = [{ type: "file", uri: "https://example.com/private.png", name: "image.png" }]
  await expect(buildThreadHandoffAttachments(sequence, "source")).rejects.toThrow("unresolvable")
})

it("ignores non-file content and absent manifest references", async () => {
  expect(
    await buildThreadHandoffAttachments(
      [
        {
          turnId: "text",
          role: "user",
          text: "hello",
          parts: [{ type: "custom", customType: "note", summary: "hello" }],
        },
      ],
      "source"
    )
  ).toEqual([])
  expect(
    await verifiedThreadHandoffAttachmentRefs(ticket([{ attachmentId: "missing" } as never]))
  ).toEqual([])
})

it("uses the source session scope before a target session has been allocated", async () => {
  await storeMedia()
  const manifest = await buildThreadHandoffAttachments(turns(), "source")
  expect(
    await verifiedThreadHandoffAttachmentRefs({
      ...ticket(manifest),
      target: { hostRef: "phone", kind: "mobile" },
    })
  ).toEqual([ref])
  mockMedia.clear()
  expect(
    await verifiedThreadHandoffAttachmentRefs({
      ...ticket(manifest),
      target: { hostRef: "phone", kind: "mobile" },
    })
  ).toEqual([])
})

it("rejects changed source bytes before uploading and rejects dishonest upload receipts", async () => {
  await storeMedia()
  const manifest = await buildThreadHandoffAttachments(turns(), "source")
  const transport = { call: jest.fn(), subscribe: () => () => {} }
  mockMedia.clear()
  await expect(stageRemoteThreadHandoffAttachments(ticket(manifest), transport)).rejects.toThrow(
    "integrity_failed"
  )
  expect(transport.call).not.toHaveBeenCalled()
  await storeMedia()
  transport.call.mockResolvedValue({
    uploadId: "upload",
    complete: true,
    ref: "cognia-upload:upload",
    resumeOffset: 3,
    chunkSize: 3,
  })
  // The commit response is independently verified, even after a resumed upload.
  transport.call.mockResolvedValueOnce({
    uploadId: "upload",
    complete: false,
    resumeOffset: 0,
    chunkSize: 3,
  })
  transport.call.mockResolvedValueOnce({ receivedBytes: 3 })
  transport.call.mockResolvedValueOnce({
    ref: "cognia-upload:upload",
    hash: "wrong",
    size: 3,
    mediaType: "image/png",
  })
  await expect(stageRemoteThreadHandoffAttachments(ticket(manifest), transport)).rejects.toThrow(
    "integrity_failed"
  )
})

it("promotes temporary upload references before exporting so both carriers preserve durable content", async () => {
  const digest = await sha256Bytes(bytes)
  await getDb().sessionAttachmentUploads.put({
    uploadId: "source-upload",
    sessionId: "source",
    deviceId: "source-device",
    name: "note.txt",
    mediaType: "text/plain",
    size: 3,
    hash: digest,
    receivedBytes: 3,
    bytes,
    status: "committed",
    createdAt: 1,
    updatedAt: 1,
    expiresAt: Date.now() + 1000,
  })
  const sequence = turns()
  sequence[0].parts = [{ type: "file", uri: "cognia-upload:source-upload", name: "note.txt" }]
  const manifest = await buildThreadHandoffAttachments(sequence, "source")
  expect(manifest[0]).toMatchObject({ attachmentId: mediaRef(digest), ref: mediaRef(digest) })
  expect(sequence[0].parts[0]).toMatchObject({ uri: mediaRef(digest) })
  expect(await getDb().messageMediaRefs.toArray()).toEqual([
    { messageId: "u", sessionId: "source", hash: digest },
  ])
  await getDb().sessionAttachmentUploads.clear()
  expect(await verifiedThreadHandoffAttachmentRefs(ticket(manifest))).toEqual([mediaRef(digest)])
})

it("fetches missing media through the source session's authenticated binary route and verifies it", async () => {
  const manifest = [
    {
      ref,
      attachmentId: ref,
      filename: "image.png",
      mediaType: "image/png",
      byteLength: 3,
      digest: await sha256Bytes(bytes),
      carriage: "by-ref" as const,
    },
  ]
  const readBinary = jest.fn().mockResolvedValue({ bytes, mediaType: "image/png" })
  const transport = { readBinary, call: jest.fn(), subscribe: () => () => {} }
  await receiveThreadHandoffAttachments(ticket(manifest), transport)
  expect(readBinary).toHaveBeenCalledWith({
    kind: "session-media",
    sessionId: "source",
    hash,
    variant: "canonical",
  })
  expect(await verifiedThreadHandoffAttachmentRefs(ticket(manifest))).toEqual([ref])
  await receiveThreadHandoffAttachments(ticket(manifest), transport)
  expect(readBinary).toHaveBeenCalledTimes(1)
})

it("rejects corrupt bytes without persisting them", async () => {
  const manifest = [
    {
      ref,
      attachmentId: ref,
      filename: "image.png",
      mediaType: "image/png",
      byteLength: 3,
      digest: "b".repeat(64),
      carriage: "by-ref" as const,
    },
  ]
  await expect(
    receiveThreadHandoffAttachments(ticket(manifest), {
      readBinary: jest.fn().mockResolvedValue({ bytes, mediaType: "image/png" }),
      call: jest.fn(),
      subscribe: () => () => {},
    })
  ).rejects.toThrow("integrity_failed")
  expect(mockMedia.size).toBe(0)
})

it("does not count a thumbnail or metadata-only upload as a verified attachment", async () => {
  await storeMedia()
  mockMedia.get(hash)!.canonicalAvailable = false
  await expect(buildThreadHandoffAttachments(turns(), "source")).rejects.toThrow("unresolvable")
  const unresolved = [
    {
      ref: "cognia-upload:missing",
      attachmentId: "missing",
      filename: "doc.txt",
      mediaType: "text/plain",
      byteLength: 3,
      digest: hash,
      carriage: "by-ref" as const,
    },
  ]
  expect(await verifiedThreadHandoffAttachmentRefs(ticket(unresolved))).toEqual([])
  await expect(
    receiveThreadHandoffAttachments(ticket(unresolved), {
      call: jest.fn(),
      subscribe: () => () => {},
    })
  ).rejects.toThrow("unresolvable")
})

it("stages remote media through the resumable uploader without changing canonical URIs", async () => {
  await storeMedia()
  const manifest = await buildThreadHandoffAttachments(turns(), "source")
  const calls: string[] = []
  const call = jest.fn(async (name: string, _args?: unknown) => {
    calls.push(name)
    if (name.endsWith("_init"))
      return { uploadId: "upload", chunkSize: 2, resumeOffset: 0, complete: false }
    if (name.endsWith("_chunk"))
      return {
        receivedBytes: calls.filter((value) => value.endsWith("_chunk")).length === 1 ? 2 : 3,
      }
    return {
      ref: "cognia-upload:upload",
      name: "image.png",
      mediaType: "image/png",
      size: 3,
      hash: manifest[0].digest,
    }
  })
  const staged = await stageRemoteThreadHandoffAttachments(ticket(manifest), {
    call: call as never,
    subscribe: () => () => {},
  })
  expect(staged[0]).toMatchObject({
    attachmentId: ref,
    ref: "cognia-upload:upload",
    digest: manifest[0].digest,
  })
  expect(call.mock.calls[0][1]).toMatchObject({
    sessionId: `thread-handoff:ticket:${manifest[0].digest}`,
  })
  expect(calls).toEqual([
    "session_attachment_upload_init",
    "session_attachment_upload_chunk",
    "session_attachment_upload_chunk",
    "session_attachment_upload_commit",
  ])
})

it("promotes verified remote staging bytes to permanent canonical media and rejects other ticket scopes", async () => {
  await storeMedia()
  const manifest = await buildThreadHandoffAttachments(turns(), "source")
  mockMedia.clear()
  const staged = [{ ...manifest[0], ref: "cognia-upload:uploaded" }]
  await getDb().sessionAttachmentUploads.put({
    uploadId: "uploaded",
    sessionId: `thread-handoff:ticket:${manifest[0].digest}`,
    deviceId: "source-device",
    name: "image.png",
    mediaType: "image/png",
    size: 3,
    hash: manifest[0].digest,
    receivedBytes: 3,
    bytes,
    status: "committed",
    createdAt: 1,
    updatedAt: 1,
    expiresAt: Date.now() + 1000,
  })
  expect(
    await verifiedThreadHandoffAttachmentRefs({ ...ticket(staged), ticketId: "other" })
  ).toEqual([])
  expect(await verifiedThreadHandoffAttachmentRefs(ticket(staged))).toEqual([
    "cognia-upload:uploaded",
  ])
  expect(mockMedia.get(hash)).toMatchObject({ canonicalAvailable: true, byteSize: 3 })
  await getDb().sessionAttachmentUploads.clear()
  expect(await verifiedThreadHandoffAttachmentRefs(ticket(staged))).toEqual([
    "cognia-upload:uploaded",
  ])
})
