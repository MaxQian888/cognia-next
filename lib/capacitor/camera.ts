"use client"

import { dataUrlToBase64, makeDefaultLoader, readFileAsDataUrl } from "./_shared"

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

/**
 * True only when the native `@capacitor/camera` plugin is registered on the
 * Capacitor bridge. Used to decide — synchronously, before any `await` — that
 * we should take the web `<input>` fallback.
 *
 * Why it has to be synchronous: on a Capacitor device that ships the static
 * `out/` bundle WITHOUT the native Camera plugin, `await loader()` runs a
 * dynamic `import("@capacitor/camera")` that rejects across a macrotask. By
 * the time the fallback's `input.click()` fires, the transient user activation
 * from the tap is gone, so the file dialog never opens and neither `change`
 * nor `cancel` fires — the picker promise hangs forever and the button looks
 * dead. Short-circuiting here keeps `input.click()` in the same task as the
 * tap. Injected loaders (tests / a future real loader) bypass this entirely.
 */
function hasNativeCamera(): boolean {
  const cap = (globalThis as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor?.Plugins
  return Boolean(cap?.Camera)
}

/**
 * Opens a transient `<input type="file">` and resolves the chosen files
 * (empty array = the user dismissed the picker). This is the cross-shell
 * fallback for when the native `@capacitor/camera` plugin isn't present —
 * i.e. the browser dev server, the Tauri desktop shell, and PWA. The `out/`
 * static export runs in all three, but `window.Capacitor.Plugins.Camera`
 * only exists inside the Capacitor native shell, so without this fallback the
 * "take photo" affordances were dead everywhere else.
 *
 * Injectable so tests can drive the branch without a real file dialog.
 */
export type WebFilePicker = (opts: {
  accept: string
  /** Forwarded to the input's `capture` attribute (e.g. "environment"). */
  capture?: string
  multiple: boolean
}) => Promise<File[]>

const defaultWebFilePicker: WebFilePicker = ({ accept, capture, multiple }) =>
  // Callers (webPickPhoto / webPickMultiple) already short-circuit when
  // `document` is absent, so this only runs in a real DOM.
  new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = accept
    if (capture) input.setAttribute("capture", capture)
    if (multiple) input.multiple = true
    input.style.position = "fixed"
    input.style.left = "-9999px"
    let settled = false
    const finish = (files: File[]) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(files)
    }
    input.addEventListener("change", () => finish(input.files ? Array.from(input.files) : []))
    // Modern browsers fire `cancel` on the input when the dialog is dismissed.
    input.addEventListener("cancel", () => finish([]))
    document.body.appendChild(input)
    input.click()
  })

function objectUrlFor(file: File): string | undefined {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return undefined
  return URL.createObjectURL(file)
}

function formatOf(file: File): string {
  const fromType = file.type.includes("/") ? file.type.split("/")[1] : ""
  if (fromType) return fromType
  const fromName = file.name.includes(".") ? file.name.split(".").pop() : ""
  return fromName || "jpeg"
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
  /** Override the web `<input type="file">` fallback (tests). */
  picker?: WebFilePicker
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
    picker = defaultWebFilePicker,
  } = opts

  // Fast path: when the real (default) loader would run but no native Camera
  // plugin is registered, go straight to the web picker so `input.click()`
  // stays inside the tap's user-activation window (see hasNativeCamera).
  if (loader === defaultLoader && !hasNativeCamera()) {
    return webPickPhoto(source, resultType, picker)
  }

  let plugin: CameraShape
  try {
    plugin = await loader()
  } catch {
    // No native plugin (browser / Tauri / PWA) → degrade to a file picker so
    // "take photo" still captures (camera on mobile browsers via `capture`,
    // a file chooser elsewhere) instead of dead-ending at `unsupported`.
    return webPickPhoto(source, resultType, picker)
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

async function webPickPhoto(
  source: CameraSource,
  resultType: ResultType,
  picker: WebFilePicker
): Promise<PhotoOutcome> {
  if (typeof document === "undefined") return { kind: "unsupported" }
  let files: File[]
  try {
    files = await picker({
      accept: "image/*",
      capture: source === "camera" ? "environment" : undefined,
      multiple: false,
    })
  } catch (err: unknown) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) }
  }
  const file = files[0]
  if (!file) return { kind: "cancelled" }
  const dataUrl = await readFileAsDataUrl(file)
  return {
    kind: "captured",
    base64: dataUrlToBase64(dataUrl),
    dataUrl: resultType === "dataUrl" ? dataUrl : undefined,
    uri: objectUrlFor(file),
    format: formatOf(file),
  }
}

export interface PickMultipleOptions {
  quality?: number
  limit?: number
  loader?: CameraLoader
  /** Override the web `<input type="file" multiple>` fallback (tests). */
  picker?: WebFilePicker
}

export type PickMultipleOutcome =
  | { kind: "picked"; photos: Array<{ uri: string; format: string }> }
  | { kind: "cancelled" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }

export async function pickMultiplePhotos(
  opts: PickMultipleOptions = {}
): Promise<PickMultipleOutcome> {
  const { quality = 80, limit = 9, loader = defaultLoader, picker = defaultWebFilePicker } = opts

  // Same activation-preserving fast path as pickPhoto (see hasNativeCamera).
  if (loader === defaultLoader && !hasNativeCamera()) {
    return webPickMultiple(picker)
  }

  let plugin: CameraShape
  try {
    plugin = await loader()
  } catch {
    return webPickMultiple(picker)
  }

  try {
    const r = await plugin.pickImages({ quality, limit })
    if (r.photos.length === 0) return { kind: "cancelled" }
    return {
      kind: "picked",
      photos: r.photos.map((p) => ({ uri: p.webPath, format: p.format })),
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/cancel/i.test(msg)) return { kind: "cancelled" }
    return { kind: "error", message: msg }
  }
}

async function webPickMultiple(picker: WebFilePicker): Promise<PickMultipleOutcome> {
  if (typeof document === "undefined") return { kind: "unsupported" }
  let files: File[]
  try {
    files = await picker({ accept: "image/*", multiple: true })
  } catch (err: unknown) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) }
  }
  if (files.length === 0) return { kind: "cancelled" }
  return {
    kind: "picked",
    photos: files.map((f) => ({ uri: objectUrlFor(f) ?? "", format: formatOf(f) })),
  }
}
