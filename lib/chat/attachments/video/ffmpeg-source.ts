/**
 * The desktop fallback: `crates/cognia-media` (system ffmpeg) behind the
 * frame-source contract.
 *
 * Used only when the webview cannot decode a file and this renderer IS the
 * native host (decision D4). The Rust commands take a path they can register,
 * while the composer holds a browser `File`, so the source is first copied into
 * AppData and removed again on close. Only commands that already exist are
 * used: `video_get_info` to probe and register, `plugin_media_get_video_frame`
 * for each frame, and `plugin_media_export_video` to cut a trimmed native clip.
 *
 * Not reachable from a paired companion. The companion media RPC authorises
 * Host paths, and the bytes of a file picked on a phone are not on the Host.
 */

import { transport } from "@/lib/tauri"
import { callMediaBinary } from "@/lib/media/transport"
import { decodeNativeVideoFrame } from "@/lib/media/native-video-frame"
import { getActiveRemoteEndpoint } from "@/lib/tauri/transport-routing"
import { detectHostProfile } from "@/lib/platform/capabilities"
import type { VideoRange } from "./settings"
import { fitBuffer } from "./storyboard"
import { NATIVE_VIDEO_MAX_BYTES } from "./delivery-gate"
import { NATIVE_VIDEO_MEDIA_TYPES } from "./browser-source"
import {
  NativeVideoPrepareError,
  VideoPreprocessError,
  throwIfAborted,
  type MotionFrameSource,
} from "./frame-source"

/** Subdirectory of AppData the staged copies live in. */
export const FFMPEG_STAGING_DIR = "composer-video-staging"
/** Chunk size for the append-write copy; `write_file` is the granted fs command. */
export const FFMPEG_STAGING_CHUNK_BYTES = 8 * 1024 * 1024

interface NativeVideoInfo {
  durationMs: number
  width: number
  height: number
  fps: number
  codec: string
  fileSize: number
  hasAudio: boolean
  sourceToken: string
}

export interface StagedFile {
  path: string
  remove(): Promise<void>
}

export interface FfmpegSourceDeps {
  stageFile(blob: Blob, extension: string): Promise<StagedFile>
  call<T>(command: string, args: Record<string, unknown>): Promise<T>
  callBinary(
    command: "plugin_media_get_video_frame" | "plugin_media_export_video",
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Uint8Array>
}

/**
 * True when ffmpeg commands run on THIS machine: a desktop shell that is not
 * attached to a remote endpoint. Keyed on the host profile rather than
 * `isTauri()`, so jsdom and node suites never look like a native host.
 */
export function canUseLocalFfmpeg(): boolean {
  return detectHostProfile() === "desktop" && !getActiveRemoteEndpoint()
}

function randomId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function stageFileInAppData(blob: Blob, extension: string): Promise<StagedFile> {
  const [{ BaseDirectory, mkdir, remove, writeFile }, { appDataDir, join }] = await Promise.all([
    import("@tauri-apps/plugin-fs"),
    import("@tauri-apps/api/path"),
  ])
  const safeExtension = /^[a-z0-9]{1,8}$/i.test(extension) ? extension.toLowerCase() : "bin"
  const relative = `${FFMPEG_STAGING_DIR}/${randomId()}.${safeExtension}`
  await mkdir(FFMPEG_STAGING_DIR, { baseDir: BaseDirectory.AppData, recursive: true })
  const removeStaged = () => remove(relative, { baseDir: BaseDirectory.AppData }).catch(() => {})
  try {
    // Chunked appends keep a 500 MB source from ever being one IPC payload.
    for (let offset = 0; offset < blob.size || offset === 0; offset += FFMPEG_STAGING_CHUNK_BYTES) {
      const chunk = new Uint8Array(
        await blob.slice(offset, offset + FFMPEG_STAGING_CHUNK_BYTES).arrayBuffer()
      )
      await writeFile(relative, chunk, { baseDir: BaseDirectory.AppData, append: offset > 0 })
      if (blob.size === 0) break
    }
  } catch (error) {
    await removeStaged()
    throw error
  }
  return { path: await join(await appDataDir(), relative), remove: removeStaged }
}

export const defaultFfmpegSourceDeps: FfmpegSourceDeps = {
  stageFile: stageFileInAppData,
  call: (command, args) => transport.call(command, args),
  callBinary: (command, args, signal) => callMediaBinary(command, args, signal),
}

/**
 * `VideoError::MissingDependency` crosses IPC as `{ code: "MISSING_DEPENDENCY",
 * binary }` (serde-tagged), or — once a transport wraps it — as its Display
 * text. Any other ffmpeg/ffprobe failure is a failure, not an absence.
 */
export function isMissingFfmpegError(error: unknown): boolean {
  if (
    error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "MISSING_DEPENDENCY"
  ) {
    return true
  }
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error ?? "")
  return /MISSING_DEPENDENCY|MissingDependency|was not found on PATH/.test(text)
}

/** A readable message for whatever an IPC call rejected with (Error, string or a serde object). */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message
  }
  return JSON.stringify(error ?? null)
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".")
  return dot < 0 ? "bin" : filename.slice(dot + 1)
}

export async function openFfmpegVideoSource(
  blob: Blob,
  mediaType: string,
  filename: string,
  deps: FfmpegSourceDeps = defaultFfmpegSourceDeps
): Promise<MotionFrameSource> {
  let staged: StagedFile
  try {
    staged = await deps.stageFile(blob, extensionOf(filename))
  } catch (error) {
    throw new VideoPreprocessError(
      "failed",
      `could not stage the video for ffmpeg: ${errorText(error)}`,
      "failed"
    )
  }

  let info: NativeVideoInfo
  try {
    info = await deps.call<NativeVideoInfo>("video_get_info", { filePath: staged.path })
  } catch (error) {
    await staged.remove()
    throw new VideoPreprocessError(
      "undecodable",
      `ffmpeg could not open the video: ${errorText(error)}`,
      isMissingFfmpegError(error) ? "missing" : "failed"
    )
  }
  if (!(info.durationMs > 0 && info.width > 0 && info.height > 0)) {
    await staged.remove()
    throw new VideoPreprocessError("undecodable", "ffmpeg found no video track", "failed")
  }

  const durationSec = info.durationMs / 1000

  return {
    engine: "ffmpeg",
    info: {
      kind: "video",
      mediaType,
      durationSec,
      width: info.width,
      height: info.height,
    },
    async grab(times, box, options = {}) {
      const frames = []
      for (const time of times) {
        throwIfAborted(options.signal)
        const target = Math.min(Math.max(0, time), Math.max(0, durationSec - 0.05))
        const response = await deps.callBinary(
          "plugin_media_get_video_frame",
          { sourceToken: info.sourceToken, time: target },
          options.signal
        )
        frames.push(fitBuffer(decodeNativeVideoFrame(response), box.maxWidth, box.maxHeight))
        options.onFrame?.()
      }
      return frames
    },
    async readNative(range: VideoRange | null, signal?: AbortSignal) {
      throwIfAborted(signal)
      if (!range) {
        if (!NATIVE_VIDEO_MEDIA_TYPES.has(mediaType)) {
          throw new NativeVideoPrepareError(
            "format",
            `${mediaType} is not accepted as a native video`
          )
        }
        if (blob.size > NATIVE_VIDEO_MAX_BYTES) {
          throw new NativeVideoPrepareError("too-large", "the video is over the native size limit")
        }
        return { bytes: new Uint8Array(await blob.arrayBuffer()), mediaType }
      }
      let bytes: Uint8Array
      try {
        bytes = await deps.callBinary(
          "plugin_media_export_video",
          {
            clips: [
              {
                sourceToken: info.sourceToken,
                startTime: range.startSec,
                endTime: range.endSec,
                volume: 1,
                playbackSpeed: 1,
                effects: [],
                transitionOut: null,
              },
            ],
            options: {
              format: "mp4",
              // A trimmed clip for a model: 720p is past what Gemini samples at,
              // and keeps a minute of footage well under the native ceiling.
              resolution: Math.min(info.width, info.height) >= 720 ? "720p" : "480p",
              fps: Math.min(30, Math.max(1, Math.round(info.fps || 30))),
              quality: "medium",
            },
          },
          signal
        )
      } catch (error) {
        throw new NativeVideoPrepareError(
          isMissingFfmpegError(error) ? "ffmpeg-missing" : "failed",
          `ffmpeg could not cut the clip: ${errorText(error)}`
        )
      }
      if (bytes.byteLength > NATIVE_VIDEO_MAX_BYTES) {
        throw new NativeVideoPrepareError(
          "too-large",
          "the trimmed clip is over the native size limit"
        )
      }
      return { bytes, mediaType: "video/mp4" }
    },
    async close() {
      await staged.remove()
    },
  }
}
