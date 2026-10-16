/** @jest-environment node */
import {
  AttachmentUploadError,
  base64ToBytes,
  bytesToBase64,
  sha256Hex,
  uploadAttachment,
} from "./attachment-upload"

function fakeHost(
  options: { chunkSize?: number; received?: number; existing?: string; lie?: boolean } = {}
) {
  const chunks: { offset: number; bytes: number[] }[] = []
  const calls: string[] = []
  let held = options.received ?? 0
  const host = {
    uploadInit: jest.fn(async (request: { size: number; hash: string }) => {
      calls.push(`init:${request.size}:${request.hash.slice(0, 8)}`)
      return {
        uploadId: "u1",
        chunkSize: options.chunkSize ?? 4,
        receivedBytes: held,
        ...(options.existing ? { attachmentId: options.existing } : {}),
      }
    }),
    uploadChunk: jest.fn(async (request: { offset: number; dataBase64: string }) => {
      const bytes = [...base64ToBytes(request.dataBase64)]
      chunks.push({ offset: request.offset, bytes })
      held = options.lie ? request.offset : request.offset + bytes.length
      return { receivedBytes: held }
    }),
    uploadCommit: jest.fn(async () => {
      calls.push("commit")
      return { attachmentId: "att-1" }
    }),
    uploadAbort: jest.fn(async () => {
      calls.push("abort")
    }),
  }
  return { host, chunks, calls }
}

const file = (size: number, mediaType = "image/png") => ({
  name: "shot.png",
  mediaType,
  kind: "screenshot" as const,
  bytes: Uint8Array.from({ length: size }, (_, index) => index),
})

describe("encoding helpers", () => {
  it("hashes and round-trips base64", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 256)
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  })
})

describe("uploadAttachment", () => {
  it("sends the file in the Host's chunk size and commits", async () => {
    const { host, chunks, calls } = fakeHost()
    const progress: number[] = []
    await expect(
      uploadAttachment(host, "sub-1", file(10), { onProgress: (sent) => progress.push(sent) })
    ).resolves.toEqual({ attachmentId: "att-1", kind: "screenshot" })
    expect(chunks.map((chunk) => [chunk.offset, chunk.bytes.length])).toEqual([
      [0, 4],
      [4, 4],
      [8, 2],
    ])
    expect(chunks.flatMap((chunk) => chunk.bytes)).toEqual([...file(10).bytes])
    expect(progress).toEqual([0, 4, 8, 10])
    expect(calls.at(-1)).toBe("commit")
    expect(host.uploadInit.mock.calls[0]?.[0]).toMatchObject({
      submissionId: "sub-1",
      size: 10,
      mediaType: "image/png",
    })
  })

  it("resumes from what the Host holds", async () => {
    const { host, chunks } = fakeHost({ received: 8 })
    await uploadAttachment(host, "sub-1", file(10))
    expect(chunks.map((chunk) => chunk.offset)).toEqual([8])
  })

  it("is done at init when the Host already has the file", async () => {
    const { host, chunks } = fakeHost({ existing: "att-9" })
    await expect(uploadAttachment(host, "sub-1", file(10))).resolves.toEqual({
      attachmentId: "att-9",
      kind: "screenshot",
    })
    expect(chunks).toEqual([])
    expect(host.uploadCommit).not.toHaveBeenCalled()
  })

  it("aborts the staged upload when the Host falls behind", async () => {
    const { host, calls } = fakeHost({ lie: true })
    await expect(uploadAttachment(host, "sub-1", file(10))).rejects.toMatchObject({
      code: "attachment_upload_failed",
    })
    expect(calls.at(-1)).toBe("abort")
  })

  it("aborts when cancelled", async () => {
    const { host, calls } = fakeHost()
    const controller = new AbortController()
    controller.abort()
    await expect(
      uploadAttachment(host, "sub-1", file(10), { signal: controller.signal })
    ).rejects.toThrow("aborted")
    expect(calls.at(-1)).toBe("abort")
  })

  it("refuses empty, oversized and unsupported files before init", async () => {
    const { host } = fakeHost()
    await expect(uploadAttachment(host, "s", file(0))).rejects.toBeInstanceOf(AttachmentUploadError)
    await expect(uploadAttachment(host, "s", file(11), { maxBytes: 10 })).rejects.toMatchObject({
      code: "attachment_too_large",
    })
    await expect(uploadAttachment(host, "s", file(3, "text/html"))).rejects.toMatchObject({
      code: "attachment_type_unsupported",
    })
    expect(host.uploadInit).not.toHaveBeenCalled()
  })
})
