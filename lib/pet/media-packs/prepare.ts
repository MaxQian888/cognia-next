import { localTransport } from "@/lib/tauri/transport-instance"
import { isTauri } from "@/lib/platform/detect"
import {
  activeDatabaseAppDataDir,
  PET_MEDIA_STAGING_APP_DATA_DIR,
} from "@/lib/tauri/account-app-data"
import { writeBlobToAppData, removeAppDataFile } from "@/lib/tauri/app-data-files"
import { MediaPackImportError } from "./import"
import {
  MAX_MEDIA_PACK_BYTES,
  referencedMediaFiles,
  validateMediaAsset,
  type MediaPackAsset,
  type MediaClip,
} from "./manifest"

interface VideoInfo {
  durationMs: number
  sourceToken: string
}
export interface MediaPrepareDeps {
  stage(blob: Blob): Promise<{ path: string; remove(): Promise<void> }>
  probe(path: string): Promise<VideoInfo>
  sheet(
    token: string,
    options: { fps: number; frameCount: number; maxEdge: number; format: "webp" }
  ): Promise<Uint8Array>
}
const defaults: MediaPrepareDeps = {
  async stage(blob) {
    const relative = `${activeDatabaseAppDataDir(PET_MEDIA_STAGING_APP_DATA_DIR)}/${crypto.randomUUID()}.webm`
    const path = await writeBlobToAppData(relative, blob)
    return { path, remove: () => removeAppDataFile(relative) }
  },
  probe: (path) => localTransport.call("video_get_info", { filePath: path }),
  async sheet(sourceToken, animationSheet) {
    const response = await localTransport.call<ArrayBuffer | Uint8Array | number[]>(
      "plugin_media_get_video_frame",
      { sourceToken, time: 0, animationSheet }
    )
    return response instanceof Uint8Array ? response : new Uint8Array(response)
  },
}

/** Decode once at import, preserving alpha on WebViews that cannot composite WebM alpha. */
export async function prepareMediaPackForDesktop(
  asset: MediaPackAsset,
  deps?: MediaPrepareDeps
): Promise<MediaPackAsset> {
  if (!Object.values(asset.manifest.clips).some((clip) => clip.kind === "video")) return asset
  if (!deps && !isTauri()) throw new MediaPackImportError("unsupported")
  const io = deps ?? defaults
  const clips = { ...asset.manifest.clips },
    files = new Map(asset.entries.map((entry) => [entry.path, entry.blob]))
  const converted = new Map<string, Extract<MediaClip, { kind: "atlas" }>>()
  const retained = new Set(
    Object.values(clips)
      .filter((clip) => clip.kind !== "video")
      .flatMap((clip) => (clip.kind === "frames" ? clip.frames : [clip.file]))
  )
  let retainedBytes = [...retained].reduce((sum, path) => sum + (files.get(path)?.size ?? 0), 0)
  for (const [id, clip] of Object.entries(clips)) {
    if (clip.kind !== "video") continue
    const previous = converted.get(clip.file)
    if (previous) {
      clips[id] = { ...previous, loop: clip.loop, noMirror: clip.noMirror }
      continue
    }
    const staged = await io.stage(files.get(clip.file)!)
    try {
      const info = await io.probe(staged.path)
      const fps = 24,
        frameCount = Math.max(1, Math.floor((info.durationMs * fps) / 1000))
      if (!Number.isFinite(info.durationMs) || info.durationMs <= 0 || frameCount > 360)
        throw new MediaPackImportError("tooLarge")
      const bytes = await io.sheet(info.sourceToken, {
        fps,
        frameCount,
        maxEdge: 256,
        format: "webp",
      })
      // Compressed sheets carry an eight-byte little-endian dimension header.
      // The native encoder is bundled, independent of FFmpeg's optional codecs.
      if (
        bytes.length < 20 ||
        ![82, 73, 70, 70].every((value, i) => bytes[i + 8] === value) ||
        ![87, 69, 66, 80].every((value, i) => bytes[i + 16] === value)
      )
        throw new MediaPackImportError("invalid")
      const imageBytes = bytes.subarray(8)
      if (retainedBytes + imageBytes.byteLength > MAX_MEDIA_PACK_BYTES)
        throw new MediaPackImportError("tooLarge")
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const columns = Math.min(16, frameCount),
        rows = Math.ceil(frameCount / columns)
      const frameWidth = view.getUint32(0, true) / columns,
        frameHeight = view.getUint32(4, true) / rows
      if (
        !Number.isInteger(frameWidth) ||
        !Number.isInteger(frameHeight) ||
        frameWidth < 1 ||
        frameHeight < 1 ||
        Math.max(frameWidth, frameHeight) > 256
      )
        throw new MediaPackImportError("invalid")
      const path = `converted/${crypto.randomUUID()}.webp`
      files.set(path, new Blob([new Uint8Array(imageBytes)], { type: "image/webp" }))
      retainedBytes += imageBytes.byteLength
      const atlas: Extract<MediaClip, { kind: "atlas" }> = {
        kind: "atlas",
        file: path,
        frameWidth,
        frameHeight,
        columns,
        frameCount,
        frameMs: 1000 / fps,
        loop: clip.loop,
        noMirror: clip.noMirror,
      }
      clips[id] = atlas
      converted.set(clip.file, atlas)
    } catch (error) {
      if (error instanceof MediaPackImportError) throw error
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "MISSING_DEPENDENCY"
      )
        throw new MediaPackImportError("decoderMissing")
      throw new MediaPackImportError("invalid")
    } finally {
      await staged.remove().catch(() => {})
    }
  }
  const manifest = { ...asset.manifest, clips }
  const entries = referencedMediaFiles(manifest).map((path) => ({ path, blob: files.get(path)! }))
  const totalBytes = entries.reduce((sum, entry) => sum + entry.blob.size, 0)
  if (totalBytes > MAX_MEDIA_PACK_BYTES) throw new MediaPackImportError("tooLarge")
  const result = { ...asset, manifest, entries, totalBytes }
  if (!validateMediaAsset(result)) throw new MediaPackImportError("invalid")
  return result
}
