"use client"

import { makeDefaultLoader, withPlugin } from "./_shared"

/**
 * `@capacitor/camera` wrapper. Inbox composer + Twin source ingest call this
 * to capture a photo or pick from the gallery. Returns a base64 string so
 * the caller can route into either the upload pipeline or the on-device
 * twin chunker without re-encoding.
 */

export type CameraSource = "camera" | "photos" | "prompt"
export type ResultType = "base64" | "uri" | "dataUrl"

interface CameraShape {
  getPhoto(opts: {
    quality?: number
    allowEditing?: boolean
    resultType: "base64" | "uri" | "dataUrl"
    source?: "CAMERA" | "PHOTOS" | "PROMPT"
    width?: number
    height?: number
    saveToGallery?: boolean
  }): Promise<{
    base64String?: string
    dataUrl?: string
    webPath?: string
    path?: string
    format: string
  }>
  pickImages(opts: { quality?: number; limit?: number }): Promise<{
    photos: Array<{ webPath: string; path?: string; format: string }>
  }>
  requestPermissions(opts?: { permissions?: Array<"camera" | "photos"> }): Promise<{
    camera: "granted" | "denied" | "prompt" | "limited" | "prompt-with-rationale"
    photos: "granted" | "denied" | "prompt" | "limited" | "prompt-with-rationale"
  }>
  checkPermissions(): Promise<{
    camera: "granted" | "denied" | "prompt" | "limited" | "prompt-with-rationale"
    photos: "granted" | "denied" | "prompt" | "limited" | "prompt-with-rationale"
  }>
}

export type CameraLoader = () => Promise<CameraShape>

const defaultLoader: CameraLoader = makeDefaultLoader<CameraShape>("@capacitor/camera", "Camera")

const SOURCE_MAP: Record<CameraSource, "CAMERA" | "PHOTOS" | "PROMPT"> = {
  camera: "CAMERA",
  photos: "PHOTOS",
  prompt: "PROMPT",
}

export interface PickPhotoOptions {
  source?: CameraSource
  quality?: number
  allowEditing?: boolean
  width?: number
  height?: number
  saveToGallery?: boolean
  resultType?: ResultType
  loader?: CameraLoader
}

export type PhotoOutcome =
  | { kind: "captured"; base64?: string; dataUrl?: string; uri?: string; format: string }
  | { kind: "permission_denied" }
  | { kind: "cancelled" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }

export async function pickPhoto(opts: PickPhotoOptions = {}): Promise<PhotoOutcome> {
  const {
    source = "prompt",
    quality = 80,
    allowEditing = false,
    width,
    height,
    saveToGallery = false,
    resultType = "base64",
    loader = defaultLoader,
  } = opts

  let plugin: CameraShape
  try {
    plugin = await loader()
  } catch {
    return { kind: "unsupported" }
  }

  try {
    let perms = await plugin.checkPermissions()
    if (
      (source === "camera" && perms.camera !== "granted") ||
      (source === "photos" && perms.photos !== "granted")
    ) {
      perms = await plugin.requestPermissions({
        permissions:
          source === "camera"
            ? ["camera"]
            : source === "photos"
              ? ["photos"]
              : ["camera", "photos"],
      })
    }
    const cameraOk = perms.camera === "granted" || perms.camera === "limited"
    const photosOk = perms.photos === "granted" || perms.photos === "limited"
    if (source === "camera" && !cameraOk) return { kind: "permission_denied" }
    if (source === "photos" && !photosOk) return { kind: "permission_denied" }
    if (source === "prompt" && !cameraOk && !photosOk) return { kind: "permission_denied" }

    const result = await plugin.getPhoto({
      quality,
      allowEditing,
      width,
      height,
      saveToGallery,
      source: SOURCE_MAP[source],
      resultType,
    })
    return {
      kind: "captured",
      base64: result.base64String,
      dataUrl: result.dataUrl,
      uri: result.webPath ?? result.path,
      format: result.format,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/cancel/i.test(msg)) return { kind: "cancelled" }
    return { kind: "error", message: msg }
  }
}

export interface PickMultipleOptions {
  quality?: number
  limit?: number
  loader?: CameraLoader
}

export type PickMultipleOutcome =
  | { kind: "picked"; photos: Array<{ uri: string; format: string }> }
  | { kind: "cancelled" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }

export async function pickMultiplePhotos(
  opts: PickMultipleOptions = {}
): Promise<PickMultipleOutcome> {
  const { quality = 80, limit = 9, loader = defaultLoader } = opts
  const result = await withPlugin(loader, async (cam) => {
    const r = await cam.pickImages({ quality, limit })
    if (r.photos.length === 0) return { kind: "cancelled" as const }
    return {
      kind: "picked" as const,
      photos: r.photos.map((p) => ({ uri: p.webPath, format: p.format })),
    }
  })
  return result
}
