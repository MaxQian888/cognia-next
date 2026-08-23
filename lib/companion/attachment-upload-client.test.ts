/** @jest-environment jsdom */
import {
  abortSessionAttachmentUpload,
  uploadSessionAttachment,
  type AttachmentUploadCall,
  type AttachmentUploadProgress,
} from "./attachment-upload-client"

jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

function bytes(length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let index = 0; index < length; index++) out[index] = index % 256
  return out
}

/**
 * A Host that behaves: it accepts sequential chunks, reports its write head,
 * and mints a ref at commit. `calls` records the wire so a test can assert on
 * what actually crossed rather than on the answer alone.
 */
function fakeHost(options: { resumeOffset?: number; chunkSize?: number; complete?: boolean } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let received = options.resumeOffset ?? 0
  const call: AttachmentUploadCall = async (name, args) => {
    calls.push({ name, args })
    switch (name) {
      case "session_attachment_upload_init":
        return {
          uploadId: "upl_1",
          chunkSize: options.chunkSize ?? 4,
          resumeOffset: received,
          complete: options.complete ?? false,
          ref: options.complete ? "cognia-upload:upl_1" : null,
        }
      case "session_attachment_upload_chunk": {
        const payload = args.dataBase64 as string
        received += atob(payload).length
        return { receivedBytes: received, complete: false }
      }
      case "session_attachment_upload_commit":
        return {
          ref: "cognia-upload:upl_1",
          name: "shot.png",
          mediaType: "image/jpeg",
          size: received,
          hash: "f".repeat(64),
        }
      default:
        return null
    }
  }
  return { call, calls }
}

describe("uploadSessionAttachment", () => {
  it("hashes once, chunks at the size the host asked for, and returns the host's ref", async () => {
    const host = fakeHost({ chunkSize: 4 })
    const progress: AttachmentUploadProgress[] = []

    const result = await uploadSessionAttachment(
      "ses-1",
      { name: "shot.png", mediaType: "image/png", bytes: bytes(10) },
      { call: host.call, onProgress: (entry) => progress.push(entry) }
    )

    const chunks = host.calls.filter((c) => c.name === "session_attachment_upload_chunk")
    expect(chunks.map((c) => c.args.offset)).toEqual([0, 4, 8])
    expect(host.calls[0]?.args).toMatchObject({
      sessionId: "ses-1",
      name: "shot.png",
      mediaType: "image/png",
      size: 10,
    })
    expect(host.calls[0]?.args.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.ref).toBe("cognia-upload:upl_1")
    // The Host corrected the declared type; the message must carry ITS answer,
    // not the label the picker guessed from the extension.
    expect(result.mediaType).toBe("image/jpeg")
    expect(progress.at(-1)).toEqual({ uploadedBytes: 10, totalBytes: 10, uploadId: "upl_1" })
  })

  it("resumes from the offset the host reports instead of resending the file", async () => {
    const host = fakeHost({ resumeOffset: 8, chunkSize: 4 })

    await uploadSessionAttachment(
      "ses-1",
      { name: "shot.png", mediaType: "image/png", bytes: bytes(12) },
      { call: host.call }
    )

    const chunks = host.calls.filter((c) => c.name === "session_attachment_upload_chunk")
    expect(chunks.map((c) => c.args.offset)).toEqual([8])
  })

  it("sends nothing at all when the host already holds this exact content", async () => {
    const host = fakeHost({ resumeOffset: 6, complete: true })

    const result = await uploadSessionAttachment(
      "ses-1",
      { name: "shot.png", mediaType: "image/png", bytes: bytes(6) },
      { call: host.call }
    )

    expect(host.calls.map((c) => c.name)).toEqual(["session_attachment_upload_init"])
    expect(result.ref).toBe("cognia-upload:upl_1")
    expect(result.size).toBe(6)
  })

  it("reuses a precomputed hash rather than re-reading the file", async () => {
    const host = fakeHost()
    const hash = "a".repeat(64)

    await uploadSessionAttachment(
      "ses-1",
      { name: "shot.png", mediaType: "image/png", bytes: bytes(4), hash },
      { call: host.call, hash }
    )

    expect(host.calls[0]?.args.hash).toBe(hash)
  })

  it("follows the host's write head when its answer runs ahead of ours", async () => {
    // A host that absorbed more than this chunk carried — the client's own
    // arithmetic would leave the two permanently out of step.
    const calls: string[] = []
    let commits = 0
    const call: AttachmentUploadCall = async (name) => {
      calls.push(name)
      if (name === "session_attachment_upload_init") {
        return { uploadId: "upl_1", chunkSize: 4, resumeOffset: 0, complete: false, ref: null }
      }
      if (name === "session_attachment_upload_chunk") return { receivedBytes: 12, complete: true }
      commits++
      return {
        ref: "cognia-upload:upl_1",
        name: "shot.png",
        mediaType: "image/png",
        size: 12,
        hash: "0".repeat(64),
      }
    }

    await uploadSessionAttachment(
      "ses-1",
      { name: "shot.png", mediaType: "image/png", bytes: bytes(12) },
      { call }
    )

    expect(calls.filter((name) => name === "session_attachment_upload_chunk")).toHaveLength(1)
    expect(commits).toBe(1)
  })

  it("does not wedge on a host that answers a nonsense chunk size", async () => {
    const host = fakeHost({ chunkSize: 0 })
    await expect(
      uploadSessionAttachment(
        "ses-1",
        { name: "shot.png", mediaType: "image/png", bytes: bytes(3) },
        { call: host.call }
      )
    ).resolves.toMatchObject({ ref: "cognia-upload:upl_1" })
    expect(host.calls.filter((c) => c.name === "session_attachment_upload_chunk")).toHaveLength(1)
  })

  it("lets a refusal reach the caller instead of silently sending a text-only turn", async () => {
    const call: AttachmentUploadCall = async () => {
      throw new Error("attachment_too_large")
    }
    await expect(
      uploadSessionAttachment(
        "ses-1",
        { name: "huge.png", mediaType: "image/png", bytes: bytes(4) },
        { call }
      )
    ).rejects.toThrow("attachment_too_large")
  })
})

describe("abortSessionAttachmentUpload", () => {
  it("tells the host to drop the staging slot", async () => {
    const call = jest.fn(async () => null)
    await abortSessionAttachmentUpload("upl_9", { call })
    expect(call).toHaveBeenCalledWith("session_attachment_upload_abort", { uploadId: "upl_9" })
  })

  it("swallows a failure — the user already gave up on the file", async () => {
    const call = jest.fn(async () => {
      throw new Error("offline")
    })
    await expect(abortSessionAttachmentUpload("upl_9", { call })).resolves.toBeUndefined()
  })
})
