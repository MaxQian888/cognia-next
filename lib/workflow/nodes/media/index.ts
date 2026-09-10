/**
 * Native media action nodes: `action.media.{probe,frame,trim,concat}`
 * (`crates/cognia-media`, FFmpeg and FFprobe).
 *
 * `requires: ["media"]` covers the desktop and headless FFmpeg surface.
 * Calls use the selected host transport; source tokens remain host-owned.
 *
 * ffmpeg itself is an external dependency the capability system cannot see:
 * the Rust side does a bare PATH lookup and answers `MissingDependency`. Every
 * executor here turns that into a non-retryable error naming the binary,
 * because retrying a missing binary finds it just as missing.
 *
 * Three ops are deliberately absent:
 *
 *  - `applyEffect` and `addTransition` are no-ops in Rust today. They validate
 *    and return, and the effect only takes hold inside the export renderer, so
 *    a node for either would be a control that does nothing.
 *  - `export` is available through the plugin API, including a host workspace
 *    destination. This node family still exposes the four existing actions;
 *    it does not emit full video byte arrays into workflow step outputs.
 *
 * KNOWN LIMITATION, stated rather than hidden: `trim` and `concat` write into
 * the media temp root, which is outside every workspace root, so no
 * `action.fs.*` node can read their output. They chain into each other and
 * into `probe`, and that is all, until a publish-to-workspace command exists.
 */

import { transport } from "@/lib/tauri"
import { callMediaBinary } from "@/lib/media/transport"
import { isHeadlessHost } from "@/lib/platform/detect"
import { encodePixelBuffer } from "@/lib/images/codec"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { storeWorkflowBlob } from "@/lib/workflow/blobs/store"
import type { PixelBuffer } from "@/lib/images/pixel-buffer"
import type { StepExecutionContext } from "@/types/workflow/visual"
import { registerNodeExecutor } from "../registry"
import { nonRetryable } from "../shared/executor-support"

interface NativeVideoInfo {
  durationMs: number
  width: number
  height: number
  fps: number
  codec: string
  hasAudio: boolean
  sourceToken: string
}

function params(ctx: StepExecutionContext): Record<string, unknown> {
  return ctx.params as Record<string, unknown>
}

function str(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key]
  if (typeof v !== "string") return undefined
  const t = v.trim()
  return t.length > 0 ? t : undefined
}

function num(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key]
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

/**
 * Name a missing binary instead of surfacing a Rust variant.
 *
 * `MissingDependency` is not something a retry fixes, and "ffmpeg is not on
 * PATH" is the entire remedy, so it is worth saying rather than passing on.
 */
function translateMediaError(err: unknown, kind: string): never {
  const message = err instanceof Error ? err.message : String(err)
  const code = err && typeof err === "object" && "code" in err ? err.code : undefined
  if (
    code === "MISSING_DEPENDENCY" ||
    /MissingDependency|MISSING_DEPENDENCY|(?:ffmpeg|ffprobe).*not found on PATH/i.test(message)
  ) {
    throw nonRetryable(
      `${kind}: this machine has no ffmpeg or ffprobe on PATH. Cognia does not bundle them, ` +
        `so install them and make sure the app's PATH can see them. (${message})`
    )
  }
  throw err
}

async function probe(sourcePath: string, kind: string): Promise<NativeVideoInfo> {
  try {
    return await transport.call<NativeVideoInfo>("video_get_info", { filePath: sourcePath })
  } catch (err) {
    translateMediaError(err, kind)
  }
}

function requireSourcePath(p: Record<string, unknown>, kind: string): string {
  const sourcePath = str(p, "sourcePath")
  if (!sourcePath) throw nonRetryable(`${kind} requires 'sourcePath'`)
  return sourcePath
}

function infoOutput(info: NativeVideoInfo) {
  return {
    durationMs: info.durationMs,
    durationSeconds: info.durationMs / 1000,
    width: info.width,
    height: info.height,
    fps: info.fps,
    codec: info.codec,
    hasAudio: info.hasAudio,
  }
}

registerNodeExecutor({
  kind: "action.media.probe",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const sourcePath = requireSourcePath(p, "action.media.probe")
    const info = await probe(sourcePath, "action.media.probe")
    return { output: { sourcePath, ...infoOutput(info) } }
  },
})

registerNodeExecutor({
  kind: "action.media.frame",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const sourcePath = requireSourcePath(p, "action.media.frame")
    const time = num(p, "timeSeconds")
    if (time === undefined || time < 0) {
      throw nonRetryable("action.media.frame requires a non-negative 'timeSeconds'")
    }
    const info = await probe(sourcePath, "action.media.frame")

    const headless = isHeadlessHost()
    let raw: Uint8Array
    try {
      raw = await callMediaBinary(
        "plugin_media_get_video_frame",
        {
          sourceToken: info.sourceToken,
          time,
          ...(headless ? { format: "png" } : {}),
        },
        ctx.signal
      )
    } catch (err) {
      translateMediaError(err, "action.media.frame")
    }

    const buffer = headless ? decodePngDimensions(raw) : decodeFrameResponse(raw)
    // Raw RGBA is width * height * 4 bytes, which is nobody's idea of a step
    // output. Encode once and hand back a reference the image nodes and
    // `ocr.extract` already know how to read.
    const encoded = headless
      ? { bytes: raw, mediaType: "image/png" }
      : await encodePixelBuffer(buffer as PixelBuffer, { format: "png" })
    const accountId = getActiveAccountId()
    if (!accountId) {
      throw nonRetryable(
        "action.media.frame: no unlocked account, so there is nowhere to put the frame."
      )
    }
    const handle = await storeWorkflowBlob({
      accountId,
      runId: ctx.runId,
      stepId: ctx.stepId,
      bytes: encoded.bytes,
      mediaType: encoded.mediaType,
      width: buffer.width,
      height: buffer.height,
    })
    return { output: { sourcePath, timeSeconds: time, ...handle } }
  },
})

registerNodeExecutor({
  kind: "action.media.trim",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const sourcePath = requireSourcePath(p, "action.media.trim")
    const startTime = Math.max(0, num(p, "startSeconds") ?? 0)
    const endSeconds = num(p, "endSeconds")
    if (endSeconds === undefined) throw nonRetryable("action.media.trim requires 'endSeconds'")
    if (endSeconds <= startTime) {
      throw nonRetryable("action.media.trim: 'endSeconds' has to be after 'startSeconds'")
    }
    const info = await probe(sourcePath, "action.media.trim")

    let result: { outputPath: string }
    try {
      result = await transport.call<{ outputPath: string }>("video_trim", {
        options: {
          sourceToken: info.sourceToken,
          startTime,
          endTime: endSeconds,
          format: str(p, "format") ?? "mp4",
        },
      })
    } catch (err) {
      translateMediaError(err, "action.media.trim")
    }

    const trimmed = await probe(result.outputPath, "action.media.trim")
    return {
      output: {
        sourcePath,
        // Under the media temp root, so no `action.fs.*` node can read it. It
        // chains into another media node, and that is the whole of it today.
        outputPath: result.outputPath,
        startSeconds: startTime,
        endSeconds,
        ...infoOutput(trimmed),
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.media.concat",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const sourcePaths = Array.isArray(p.sourcePaths)
      ? (p.sourcePaths as unknown[]).filter((v): v is string => typeof v === "string" && !!v.trim())
      : []
    if (sourcePaths.length < 2) {
      throw nonRetryable("action.media.concat requires at least two entries in 'sourcePaths'")
    }

    // Each clip needs the authorized source token its own probe hands back.
    // There is no clip registry outside `media-api`, so the node builds the
    // native clip inputs from the paths it was given.
    const infos = await Promise.all(sourcePaths.map((path) => probe(path, "action.media.concat")))
    let result: { outputPath: string }
    try {
      result = await transport.call<{ outputPath: string }>("plugin_media_concatenate_videos", {
        clips: infos.map((info) => ({
          sourceToken: info.sourceToken,
          startTime: 0,
          endTime: info.durationMs / 1000,
          volume: 1,
          playbackSpeed: 1,
          effects: [],
        })),
      })
    } catch (err) {
      translateMediaError(err, "action.media.concat")
    }

    const joined = await probe(result.outputPath, "action.media.concat")
    return {
      output: {
        sourcePaths,
        outputPath: result.outputPath,
        clipCount: sourcePaths.length,
        ...infoOutput(joined),
      },
    }
  },
})

/**
 * Decode the native frame response.
 *
 * The Rust side answers raw RGBA behind an 8-byte little-endian width and
 * height header, not an encoded image, so the length check is the only thing
 * standing between a protocol change and a silently mis-shaped buffer.
 */
export function decodeFrameResponse(response: ArrayBuffer | Uint8Array | number[]): PixelBuffer {
  const bytes = response instanceof Uint8Array ? response : new Uint8Array(response)
  if (bytes.byteLength < 8) {
    throw nonRetryable("action.media.frame: the native frame response has no dimension header")
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(0, true)
  const height = view.getUint32(4, true)
  const expected = width * height * 4
  if (bytes.byteLength !== expected + 8) {
    throw nonRetryable(
      `action.media.frame: the native frame response carries ${bytes.byteLength - 8} pixel ` +
        `bytes where ${expected} were expected`
    )
  }
  return { width, height, data: new Uint8ClampedArray(bytes.slice(8)) }
}

/** Read dimensions from the server-encoded PNG without requiring a canvas in Node. */
function decodePngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (
    bytes.length < 33 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) ||
    ![73, 72, 68, 82].every((value, index) => bytes[index + 12] === value)
  ) {
    throw nonRetryable("action.media.frame: the host returned an invalid PNG frame")
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (view.getUint32(8) !== 13 || width === 0 || height === 0) {
    throw nonRetryable("action.media.frame: the PNG frame has invalid dimensions")
  }
  return { width, height }
}
