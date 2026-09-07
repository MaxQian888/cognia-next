/**
 * Mocked at the `invoke` boundary, because that is the boundary these nodes
 * actually have. `crates/cognia-media` is reachable only through raw Tauri
 * commands, which is the whole reason the family needs its own capability id.
 */
const invoke = jest.fn(async (_c: string, _a?: unknown): Promise<unknown> => null)
jest.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a?: unknown) => invoke(c, a) }))

const encodePixelBuffer = jest.fn(
  async (_b: unknown, _o?: unknown): Promise<{ bytes: Uint8Array; mediaType: string }> => ({
    bytes: new Uint8Array([1, 2, 3]),
    mediaType: "image/png",
  })
)
jest.mock("@/lib/images/codec", () => ({
  encodePixelBuffer: (b: unknown, o?: unknown) => encodePixelBuffer(b, o),
}))

const storeWorkflowBlob = jest.fn(async (_i: unknown): Promise<unknown> => ({
  blobRef: "cognia-workflow-blob:b1",
  mediaType: "image/png",
  byteLength: 3,
  width: 2,
  height: 1,
}))
jest.mock("@/lib/workflow/blobs/store", () => ({
  storeWorkflowBlob: (i: unknown) => storeWorkflowBlob(i),
}))

const getActiveAccountId = jest.fn(() => "acc1")
jest.mock("@/lib/accounts/active-account-id", () => ({
  getActiveAccountId: () => getActiveAccountId(),
}))

import "."
import { decodeFrameResponse } from "."
import { getExecutor } from "../registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

const INFO = {
  durationMs: 12_000,
  width: 1920,
  height: 1080,
  fps: 30,
  codec: "h264",
  hasAudio: true,
  sourceToken: "tok",
}

function run(kind: string, params: Record<string, unknown>) {
  const executor = getExecutor(kind as never, 1)!
  return executor.execute({
    params,
    workflowId: "wf1",
    runId: "run1",
    stepId: "s1",
  } as unknown as StepExecutionContext)
}

/** A raw RGBA frame behind the 8-byte little-endian dimension header. */
function frameBytes(width: number, height: number): ArrayBuffer {
  const out = new Uint8Array(8 + width * height * 4)
  new DataView(out.buffer).setUint32(0, width, true)
  new DataView(out.buffer).setUint32(4, height, true)
  return out.buffer
}

beforeEach(() => {
  jest.clearAllMocks()
  getActiveAccountId.mockReturnValue("acc1")
  invoke.mockImplementation(async (command: string) => {
    if (command === "video_get_info") return INFO
    if (command === "plugin_media_get_video_frame") return frameBytes(2, 1)
    if (command === "video_trim") return { outputPath: "/tmp/cognia-video/out.mp4" }
    if (command === "plugin_media_concatenate_videos") {
      return { outputPath: "/tmp/cognia-video/joined.mp4" }
    }
    return null
  })
})

describe("registration", () => {
  it.each(["action.media.probe", "action.media.frame", "action.media.trim", "action.media.concat"])(
    "registers %s",
    (kind) => {
      expect(getExecutor(kind as never, 1)).toBeDefined()
    }
  )

  it.each(["applyEffect", "addTransition", "export"])("registers no %s node", (op) => {
    // The first two are no-ops in Rust today and the third reads up to 128 MiB
    // over IPC. All three would be controls that do not do what they say.
    expect(getExecutor(`action.media.${op}` as never, 1)).toBeUndefined()
  })
})

describe("action.media.probe", () => {
  it("returns the metadata in seconds as well as milliseconds", async () => {
    const out = (await run("action.media.probe", { sourcePath: "/v.mp4" })).output as Record<
      string,
      unknown
    >
    expect(invoke).toHaveBeenCalledWith("video_get_info", { filePath: "/v.mp4" })
    expect(out).toMatchObject({
      durationMs: 12_000,
      durationSeconds: 12,
      width: 1920,
      fps: 30,
      codec: "h264",
      hasAudio: true,
    })
  })

  it("never leaks the source token into the output", async () => {
    // It is an authorization handle for the native layer, not data a graph
    // should be able to pass around.
    const out = (await run("action.media.probe", { sourcePath: "/v.mp4" })).output
    expect(JSON.stringify(out)).not.toContain("tok")
  })

  it("requires a source path", async () => {
    await expect(run("action.media.probe", {})).rejects.toThrow(/requires 'sourcePath'/)
  })
})

describe("action.media.frame", () => {
  it("encodes the raw frame and returns a reference, never the pixels", async () => {
    const out = (await run("action.media.frame", { sourcePath: "/v.mp4", timeSeconds: 3 }))
      .output as Record<string, unknown>
    expect(invoke).toHaveBeenCalledWith("plugin_media_get_video_frame", {
      sourceToken: "tok",
      time: 3,
    })
    expect(encodePixelBuffer).toHaveBeenCalledTimes(1)
    expect(storeWorkflowBlob).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run1", stepId: "s1", mediaType: "image/png" })
    )
    expect(out).toMatchObject({ blobRef: "cognia-workflow-blob:b1", timeSeconds: 3 })
  })

  it("requires a non-negative timestamp", async () => {
    await expect(run("action.media.frame", { sourcePath: "/v.mp4" })).rejects.toThrow(
      /non-negative 'timeSeconds'/
    )
    await expect(
      run("action.media.frame", { sourcePath: "/v.mp4", timeSeconds: -1 })
    ).rejects.toThrow(/non-negative 'timeSeconds'/)
  })
})

describe("action.media.trim", () => {
  it("passes the window through and probes the result", async () => {
    const out = (
      await run("action.media.trim", {
        sourcePath: "/v.mp4",
        startSeconds: 2,
        endSeconds: 5,
      })
    ).output as Record<string, unknown>
    expect(invoke).toHaveBeenCalledWith("video_trim", {
      options: { sourceToken: "tok", startTime: 2, endTime: 5, format: "mp4" },
    })
    expect(out).toMatchObject({ outputPath: "/tmp/cognia-video/out.mp4", durationSeconds: 12 })
  })

  it("refuses a window that does not move forward", async () => {
    await expect(
      run("action.media.trim", { sourcePath: "/v.mp4", startSeconds: 5, endSeconds: 5 })
    ).rejects.toThrow(/has to be after/)
    await expect(run("action.media.trim", { sourcePath: "/v.mp4" })).rejects.toThrow(
      /requires 'endSeconds'/
    )
  })
})

describe("action.media.concat", () => {
  it("builds a native clip per source from its own probe", async () => {
    // There is no clip registry outside media-api, so each path has to earn
    // its own authorized source token.
    await run("action.media.concat", { sourcePaths: ["/a.mp4", "/b.mp4"] })
    const clips = (
      invoke.mock.calls.find((c) => c[0] === "plugin_media_concatenate_videos")?.[1] as {
        clips: unknown[]
      }
    ).clips
    expect(clips).toHaveLength(2)
    expect(clips[0]).toEqual({
      sourceToken: "tok",
      startTime: 0,
      endTime: 12,
      volume: 1,
      playbackSpeed: 1,
      effects: [],
    })
  })

  it("refuses fewer than two sources", async () => {
    await expect(run("action.media.concat", { sourcePaths: ["/a.mp4"] })).rejects.toThrow(
      /at least two entries/
    )
  })
})

describe("a machine with no ffmpeg", () => {
  it.each([
    ["action.media.probe", { sourcePath: "/v.mp4" }],
    ["action.media.trim", { sourcePath: "/v.mp4", endSeconds: 2 }],
  ])("%s names the missing binary and does not retry", async (kind, params) => {
    invoke.mockRejectedValue(new Error("MissingDependency: ffprobe"))
    await expect(run(kind, params)).rejects.toThrow(/no ffmpeg or ffprobe on PATH/)
    await expect(run(kind, params)).rejects.toMatchObject({ retryable: false })
  })
})

describe("decodeFrameResponse", () => {
  it("reads the little-endian dimension header", () => {
    const buffer = decodeFrameResponse(frameBytes(4, 3))
    expect(buffer).toMatchObject({ width: 4, height: 3 })
    expect(buffer.data).toHaveLength(4 * 3 * 4)
  })

  it("refuses a response whose length does not match its own header", () => {
    // The only thing standing between a protocol change and a silently
    // mis-shaped buffer.
    const truncated = new Uint8Array(frameBytes(4, 3)).slice(0, 20)
    expect(() => decodeFrameResponse(truncated)).toThrow(/pixel bytes where/)
    expect(() => decodeFrameResponse(new Uint8Array(4))).toThrow(/no dimension header/)
  })
})
