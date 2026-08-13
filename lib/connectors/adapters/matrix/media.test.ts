import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { resolveInboundMatrixMedia } from "./media"

const mockFetchAttachment = jest.fn()
const mockAttachmentRead = jest.fn()
const mockEncryptedFetch = jest.fn()

jest.mock("@/lib/connectors/attachment-fetcher", () => ({
  fetchAttachment: (...args: unknown[]) => mockFetchAttachment(...args),
}))

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsAttachmentRead: (...args: unknown[]) => mockAttachmentRead(...args),
  connectorsMatrixEncryptedMediaFetch: (...args: unknown[]) => mockEncryptedFetch(...args),
}))

function event(segment: NormalizedInboundEvent["segments"][number]): NormalizedInboundEvent {
  return {
    platform: "matrix",
    adapterId: "mx-1",
    selfId: "@bot:matrix.org",
    messageId: "$e",
    conversationRef: { platform: "matrix", adapterId: "mx-1", roomId: "!r:s", eventId: "$e" },
    conversationKey: "matrix:mx-1:!r:s",
    sender: {
      id: "matrix:!r:s:@a:s",
      platform: "matrix",
      adapterId: "mx-1",
      remoteUserId: "@a:s",
      displayName: "a",
    },
    channel: { id: "matrix:mx-1:!r:s", kind: "group", platformChannelId: "!r:s" },
    segments: [segment],
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp: 1,
    raw: {},
    kind: "create",
  }
}

beforeEach(() => {
  mockFetchAttachment.mockReset()
  mockAttachmentRead.mockReset()
  mockEncryptedFetch.mockReset()
})

describe("resolveInboundMatrixMedia", () => {
  it("fetches Matrix media with bearer auth and inlines small images", async () => {
    mockFetchAttachment.mockResolvedValue({
      ref: { localUrl: "/cache/abc", remoteRef: "mxc://matrix.org/abc" },
      cached: false,
    })
    mockAttachmentRead.mockResolvedValue(Buffer.from("hello").toString("base64"))

    const inbound = event({
      type: "image",
      url: "https://matrix.org/_matrix/client/v1/media/download/matrix.org/abc",
      rawUrl: "mxc://matrix.org/abc",
      mimeType: "image/png",
    })

    await resolveInboundMatrixMedia(inbound, { accessToken: "tok" })

    expect(mockFetchAttachment).toHaveBeenCalledWith({
      adapterId: "mx-1",
      remoteRef: "mxc://matrix.org/abc",
      sourceUrl: "https://matrix.org/_matrix/client/v1/media/download/matrix.org/abc",
      mimeType: "image/png",
      sizeBytes: undefined,
      headers: { Authorization: "Bearer tok" },
    })
    expect(mockAttachmentRead).toHaveBeenCalledWith("mx-1", "mxc://matrix.org/abc", 6 * 1024 * 1024)
    expect(inbound.segments[0]).toMatchObject({
      type: "image",
      dataBase64: Buffer.from("hello").toString("base64"),
      mimeType: "image/png",
    })
  })

  it("skips inlining when the cached image exceeds the size cap", async () => {
    mockFetchAttachment.mockResolvedValue({
      ref: { localUrl: "/cache/big", remoteRef: "mxc://matrix.org/big" },
      cached: false,
    })
    // Rust returns null for over-cap or uncached attachments.
    mockAttachmentRead.mockResolvedValue(null)

    const inbound = event({
      type: "image",
      url: "https://matrix.org/_matrix/client/v1/media/download/matrix.org/big",
      rawUrl: "mxc://matrix.org/big",
      mimeType: "image/png",
    })

    await resolveInboundMatrixMedia(inbound, { accessToken: "tok" })

    expect(inbound.segments[0]).not.toHaveProperty("dataBase64")
  })

  it("decrypts encrypted media and thumbnails through the shared Matrix cache command", async () => {
    mockEncryptedFetch.mockResolvedValue({ localUrl: "/cache/plain", remoteRef: "mxc://s/media" })
    const file = {
      url: "mxc://s/media",
      key: { kty: "oct", k: "key" },
      iv: "iv",
      hashes: { sha256: "hash" },
      v: "v2",
    }
    const thumbnailFile = { ...file, url: "mxc://s/thumb" }
    const inbound = event({
      type: "video",
      url: "https://s/_matrix/client/v1/media/download/s/media",
      rawUrl: file.url,
      thumbnailUrl: "https://s/_matrix/client/v1/media/download/s/thumb",
      matrixEncryptedFile: file,
      matrixEncryptedThumbnailFile: thumbnailFile,
    })

    await resolveInboundMatrixMedia(inbound, { accessToken: "tok" })

    expect(mockFetchAttachment).not.toHaveBeenCalled()
    expect(mockEncryptedFetch).toHaveBeenNthCalledWith(1, {
      adapterId: "mx-1",
      remoteRef: file.url,
      sourceUrl: "https://s/_matrix/client/v1/media/download/s/media",
      headers: { Authorization: "Bearer tok" },
      file,
    })
    expect(mockEncryptedFetch).toHaveBeenNthCalledWith(2, {
      adapterId: "mx-1",
      remoteRef: thumbnailFile.url,
      sourceUrl: "https://s/_matrix/client/v1/media/download/s/thumb",
      headers: { Authorization: "Bearer tok" },
      file: thumbnailFile,
    })
  })

  it("does not inline non-image media", async () => {
    mockFetchAttachment.mockResolvedValue({
      ref: { localUrl: "/cache/vid", remoteRef: "mxc://matrix.org/vid" },
      cached: false,
    })

    const inbound = event({
      type: "video",
      url: "https://matrix.org/_matrix/client/v1/media/download/matrix.org/vid",
      rawUrl: "mxc://matrix.org/vid",
      mimeType: "video/mp4",
    })

    await resolveInboundMatrixMedia(inbound, { accessToken: "tok" })

    expect(mockAttachmentRead).not.toHaveBeenCalled()
  })

  it("does not block delivery when media fetch fails", async () => {
    mockFetchAttachment.mockRejectedValue(new Error("network"))
    const inbound = event({
      type: "file",
      url: "https://matrix.org/_matrix/client/v1/media/download/matrix.org/file",
      rawUrl: "mxc://matrix.org/file",
      name: "x.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
    })

    await expect(
      resolveInboundMatrixMedia(inbound, { accessToken: "tok" })
    ).resolves.toBeUndefined()
    expect(inbound.segments[0]).toMatchObject({ type: "file", rawUrl: "mxc://matrix.org/file" })
  })

  it("does not block delivery when the inline read fails", async () => {
    mockFetchAttachment.mockResolvedValue({
      ref: { localUrl: "/cache/abc", remoteRef: "mxc://matrix.org/abc" },
      cached: false,
    })
    mockAttachmentRead.mockRejectedValue(new Error("ipc unavailable"))

    const inbound = event({
      type: "image",
      url: "https://matrix.org/_matrix/client/v1/media/download/matrix.org/abc",
      rawUrl: "mxc://matrix.org/abc",
      mimeType: "image/png",
    })

    await expect(
      resolveInboundMatrixMedia(inbound, { accessToken: "tok" })
    ).resolves.toBeUndefined()
    expect(inbound.segments[0]).not.toHaveProperty("dataBase64")
  })
})
