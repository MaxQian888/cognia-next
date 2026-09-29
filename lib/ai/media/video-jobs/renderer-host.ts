"use client"

/**
 * The app renderer's video job host (ADR-0205): jobs in Dexie, provider
 * traffic through the platform transport (the desktop WebView's CSP does not
 * allow provider hosts; mobile needs the native bridge for binary bodies),
 * start frames resolved from the conversation that asked for the video, and
 * finished videos stored where they belong:
 *
 *   - a chat job (agent tool, `/video`) → a session asset of that conversation;
 *   - a plugin or provider-operations job → an upload owned by Files.
 *
 * Storing is idempotent by asset id (`video-<jobId>`), so a job interrupted
 * between storing and settling reuses the stored video on its next attempt.
 */

import { createProviderSettingsSnapshot } from "@/lib/ai/provider-consumption"
import { openBrowserVideoSource } from "@/lib/chat/attachments/video/browser-source"
import { getMessageMedia, parseMediaRef } from "@/lib/db/message-media"
import { isMessageMediaReferencedBySession } from "@/lib/db/message-media-refs"
import { createDexieMediaJobStore } from "@/lib/db/media-generation-jobs"
import {
  SESSION_ASSET_MAX_BYTES,
  getLibraryAsset,
  getSessionAsset,
  getSessionAssetMetadata,
  putLibraryAsset,
  putSessionAsset,
} from "@/lib/db/session-assets"
import {
  createPlatformFetch,
  platformFetchKind,
  reachesNonCorsHosts,
} from "@/lib/network/platform-fetch"
import { useSettingsStore } from "@/stores/settings"
import { readBlobAsArrayBuffer } from "@cognia/ocr/blob-utils"

import type { ResolvedStartFrame, VideoJobStartFrameInput } from "./engine"
import { installVideoJobHost, type VideoJobHost } from "./host"
import type {
  MediaGenerationJobRow,
  VideoJobContent,
  VideoJobOrigin,
  VideoJobResult,
} from "./types"

/**
 * The desktop proxy bridge buffers a response in memory and refuses a body
 * over 64 MiB (`MAX_PROXY_HTTP_BODY_BYTES`, `src-tauri/src/proxy_config/commands.rs`).
 */
export const DESKTOP_BRIDGE_MAX_BYTES = 64 * 1024 * 1024

export function videoAssetId(jobId: string): string {
  return `video-${jobId}`
}

function extensionOf(mediaType: string): string {
  if (mediaType === "video/webm") return "webm"
  if (mediaType === "video/quicktime") return "mov"
  return "mp4"
}

function sessionOf(origin: VideoJobOrigin): string | undefined {
  return origin.surface === "chat-tool" || origin.surface === "slash" ? origin.sessionId : undefined
}

export interface RendererVideoJobHostDeps {
  describe?: (video: Blob) => Promise<Pick<VideoJobResult, "durationSec" | "width" | "height">>
  now?: () => number
}

/** Duration and size read by decoding the file; empty when this shell cannot. */
async function describeVideo(
  video: Blob
): Promise<Pick<VideoJobResult, "durationSec" | "width" | "height">> {
  try {
    const source = await openBrowserVideoSource(video, video.type || "video/mp4")
    try {
      const { durationSec, width, height } = source.info
      return {
        ...(Number.isFinite(durationSec) && durationSec > 0 ? { durationSec } : {}),
        ...(width > 0 ? { width } : {}),
        ...(height > 0 ? { height } : {}),
      }
    } finally {
      await source.close()
    }
  } catch {
    return {}
  }
}

export async function resolveRendererStartFrame(
  frame: VideoJobStartFrameInput,
  origin: VideoJobOrigin
): Promise<ResolvedStartFrame> {
  if (frame.kind === "bytes") return { data: frame.data, mediaType: frame.mediaType }
  const sessionId = sessionOf(origin)
  if (!sessionId) throw new Error("A start image must be given as bytes outside a conversation.")
  if (frame.kind === "media") {
    if (!parseMediaRef(frame.ref)) throw new Error("Not an image reference.")
    if (!(await isMessageMediaReferencedBySession(sessionId, frame.ref))) {
      throw new Error("That image is not part of this conversation.")
    }
    const row = await getMessageMedia(frame.ref)
    if (!row) throw new Error("That image is no longer stored.")
    const blob = row.originalBlob ?? row.blob
    const mediaType = row.originalBlob ? (row.originalMediaType ?? row.mediaType) : row.mediaType
    return { data: new Uint8Array(await readBlobAsArrayBuffer(blob)), mediaType }
  }
  const asset = await getSessionAsset(sessionId, frame.assetId)
  if (!asset) throw new Error("That attachment is not part of this conversation.")
  return {
    data: new Uint8Array(await readBlobAsArrayBuffer(asset.blob)),
    mediaType: asset.mediaType,
  }
}

async function storeVideo(row: MediaGenerationJobRow, video: Blob): Promise<VideoJobContent> {
  const assetId = videoAssetId(row.id)
  const mediaType = video.type || "video/mp4"
  const filename = `${assetId}.${extensionOf(mediaType)}`
  const sessionId = sessionOf(row.origin)
  if (sessionId) {
    if (!(await getSessionAssetMetadata(sessionId, assetId))) {
      await putSessionAsset({ sessionId, assetId, blob: video, filename, mediaType })
    }
    return { kind: "session-asset", sessionId, assetId }
  }
  if (!(await getLibraryAsset(assetId))) {
    await putLibraryAsset({
      assetId,
      blob: video,
      filename,
      mediaType,
      ...(row.projectId ? { projectId: row.projectId } : {}),
    })
  }
  return { kind: "library", assetId }
}

export async function readRendererVideo(content: VideoJobContent): Promise<Blob> {
  switch (content.kind) {
    case "inline":
      return new Blob([content.bytes as Uint8Array<ArrayBuffer>])
    case "session-asset": {
      const asset = await getSessionAsset(content.sessionId, content.assetId)
      if (!asset) throw new Error("The video is no longer stored.")
      return asset.blob
    }
    case "library": {
      const asset = await getLibraryAsset(content.assetId)
      if (!asset) throw new Error("The video is no longer stored.")
      return asset.blob
    }
  }
}

export function createRendererVideoJobHost(deps: RendererVideoJobHostDeps = {}): VideoJobHost {
  const describe = deps.describe ?? describeVideo
  return {
    store: createDexieMediaJobStore(),
    now: deps.now ?? (() => Date.now()),
    getSnapshot: () => {
      const live = useSettingsStore.getState().settings
      return createProviderSettingsSnapshot({
        defaultProvider: live?.defaultProvider,
        providerSettings: live?.providerSettings,
        customProviders: live?.customProviders,
      })
    },
    fetch: createPlatformFetch(),
    reachesNonCorsHosts,
    resolveStartFrame: resolveRendererStartFrame,
    async materialize(row, video) {
      const content = await storeVideo(row, video)
      return {
        content,
        mediaType: video.type || "video/mp4",
        byteSize: video.size,
        ...(await describe(video)),
      }
    },
    readContent: readRendererVideo,
    maxResultBytes:
      platformFetchKind() === "tauri" ? DESKTOP_BRIDGE_MAX_BYTES : SESSION_ASSET_MAX_BYTES,
  }
}

let rendererHostInstalled = false

/**
 * Install the renderer host once, before anything in this window starts or
 * checks a video job. Every renderer entry point calls it — the boot
 * initializer, the plugin media API and the renderer's provider-operations
 * executor — so a job started before the initializer mounts still lands in
 * Dexie rather than in memory.
 */
export function ensureRendererVideoJobHost(): void {
  if (rendererHostInstalled) return
  installVideoJobHost(createRendererVideoJobHost())
  rendererHostInstalled = true
}

/** Test seam: forget the install so the next `ensure` installs again. */
export function __resetRendererVideoJobHostForTests(): void {
  rendererHostInstalled = false
}
