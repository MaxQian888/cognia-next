import { invoke } from "@tauri-apps/api/core"
import { resolveLarkMediaKeys } from "./upload"
import type { MessageSegment } from "@/types/connectors/segment"

const mockInvoke = invoke as jest.Mock

describe("resolveLarkMediaKeys", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  it("passes through non-media segments unchanged", async () => {
    const segments: MessageSegment[] = [
      { type: "text", text: "hi" },
      { type: "mention", userId: "ou_user_001" },
    ]
    const out = await resolveLarkMediaKeys(segments, {
      getAccessToken: async () => "t-token",
    })
    expect(out).toEqual(segments)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("passes through media segments that already carry a Lark key (no ://)", async () => {
    const segments: MessageSegment[] = [
      { type: "voice", url: "file_v3_existing_voice" },
      { type: "image", url: "img_v3_existing" },
    ]
    const out = await resolveLarkMediaKeys(segments, {
      getAccessToken: async () => "t-token",
    })
    expect(out).toEqual(segments)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("uploads a remote voice URL via connectors_lark_upload_file with opus + duration", async () => {
    mockInvoke.mockResolvedValueOnce("file_v3_new_voice")
    const segments: MessageSegment[] = [
      { type: "voice", url: "https://media.example.com/clip.opus", durationSec: 3.5 },
    ]
    const out = await resolveLarkMediaKeys(segments, {
      getAccessToken: async () => "t-token",
    })

    expect(out).toEqual([{ type: "voice", url: "file_v3_new_voice", durationSec: 3.5 }])
    expect(mockInvoke).toHaveBeenCalledWith("connectors_lark_upload_file", {
      accessToken: "t-token",
      sourceUrl: "https://media.example.com/clip.opus",
      fileType: "opus",
      fileName: "clip.opus",
      durationMs: 3500,
    })
  })

  it("uploads a remote video URL via connectors_lark_upload_file with mp4", async () => {
    mockInvoke.mockResolvedValueOnce("file_v3_new_video")
    const segments: MessageSegment[] = [
      { type: "video", url: "https://media.example.com/demo.mp4" },
    ]
    const out = await resolveLarkMediaKeys(segments, {
      getAccessToken: async () => "t-token",
    })

    expect(out).toEqual([{ type: "video", url: "file_v3_new_video" }])
    const args = mockInvoke.mock.calls[0][1] as { fileType: string; fileName: string }
    expect(args.fileType).toBe("mp4")
    expect(args.fileName).toBe("demo.mp4")
  })

  it("uploads a remote image URL via connectors_lark_upload_image", async () => {
    mockInvoke.mockResolvedValueOnce("img_v3_new")
    const segments: MessageSegment[] = [
      { type: "image", url: "https://cdn.example.com/photo.png", alt: "hi" },
    ]
    const out = await resolveLarkMediaKeys(segments, {
      getAccessToken: async () => "t-token",
    })

    expect(out).toEqual([{ type: "image", url: "img_v3_new", alt: "hi" }])
    expect(mockInvoke).toHaveBeenCalledWith("connectors_lark_upload_image", {
      accessToken: "t-token",
      sourceUrl: "https://cdn.example.com/photo.png",
      imageType: undefined,
    })
  })

  it("uploads a remote file URL via connectors_lark_upload_file with extension-derived type", async () => {
    mockInvoke.mockResolvedValueOnce("file_v3_new_doc")
    const segments: MessageSegment[] = [
      {
        type: "file",
        url: "https://docs.example.com/report.pdf",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
      },
    ]
    const out = await resolveLarkMediaKeys(segments, {
      getAccessToken: async () => "t-token",
    })

    expect(out[0]).toMatchObject({ type: "file", url: "file_v3_new_doc", name: "report.pdf" })
    const args = mockInvoke.mock.calls[0][1] as { fileType: string; fileName: string }
    expect(args.fileType).toBe("pdf")
    expect(args.fileName).toBe("report.pdf")
  })

  it("falls back to file_type=stream for unknown extensions", async () => {
    mockInvoke.mockResolvedValueOnce("file_v3_blob")
    const segments: MessageSegment[] = [
      {
        type: "file",
        url: "https://blob.example.com/payload.dat",
        name: "payload.dat",
        mimeType: "application/octet-stream",
        sizeBytes: 1,
      },
    ]
    await resolveLarkMediaKeys(segments, { getAccessToken: async () => "t-token" })
    const args = mockInvoke.mock.calls[0][1] as { fileType: string }
    expect(args.fileType).toBe("stream")
  })

  it("only calls getAccessToken once even with multiple uploads", async () => {
    mockInvoke
      .mockResolvedValueOnce("file_v3_a")
      .mockResolvedValueOnce("img_v3_b")
      .mockResolvedValueOnce("file_v3_c")

    let tokenFetches = 0
    const segments: MessageSegment[] = [
      { type: "voice", url: "https://a.example.com/x.opus", durationSec: 1 },
      { type: "image", url: "https://b.example.com/y.png" },
      { type: "video", url: "https://c.example.com/z.mp4" },
    ]
    await resolveLarkMediaKeys(segments, {
      getAccessToken: async () => {
        tokenFetches++
        return "t-token"
      },
    })
    expect(tokenFetches).toBe(1)
    expect(mockInvoke).toHaveBeenCalledTimes(3)
  })

  it("uses the upload cache to short-circuit duplicate URLs", async () => {
    const cache = new Map<string, string>()
    mockInvoke.mockResolvedValueOnce("file_v3_cached")

    const segs: MessageSegment[] = [
      { type: "voice", url: "https://dup.example.com/v.opus", durationSec: 2 },
    ]

    const a = await resolveLarkMediaKeys(segs, {
      getAccessToken: async () => "t-token",
      uploadCache: cache,
    })
    expect(a[0]).toMatchObject({ type: "voice", url: "file_v3_cached" })
    expect(cache.get("https://dup.example.com/v.opus")).toBe("file_v3_cached")

    // Second call — same URL — should NOT re-invoke
    const b = await resolveLarkMediaKeys(segs, {
      getAccessToken: async () => "t-token",
      uploadCache: cache,
    })
    expect(b[0]).toMatchObject({ type: "voice", url: "file_v3_cached" })
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it("propagates upload errors (so the outbound runner can deadletter)", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("Lark upload HTTP 500: server error"))
    const segments: MessageSegment[] = [
      { type: "voice", url: "https://broken.example.com/x.opus", durationSec: 1 },
    ]
    await expect(
      resolveLarkMediaKeys(segments, { getAccessToken: async () => "t-token" })
    ).rejects.toThrow(/HTTP 500/)
  })
})
