"use client"

/**
 * Avatar image pipeline for the local user profile.
 *
 * Profile avatars are stored as self-contained `data:` URLs inside the
 * `AppSettings` singleton (see `UserProfile.avatarDataUrl`), which syncs to
 * companion devices and rides every WebDAV backup — so the encoded payload
 * MUST stay small. `downscaleToDataUrl` center-crops the picked file to a
 * square, downscales it to {@link AVATAR_EDGE_PX}, and walks encoder quality
 * down until the result fits under {@link MAX_AVATAR_BYTES}. Callers must
 * never persist a raw `FileReader` result.
 *
 * Decode shape mirrors `lib/appearance/image-utils.ts` (`createObjectURL` +
 * `Image`) so tests can install the same `Image` mock.
 */

export const MAX_AVATAR_BYTES = 96 * 1024
export const AVATAR_EDGE_PX = 128

/** Mime allowlist — mirrors the wallpaper uploader's `ACCEPTED` list. */
const ACCEPTED_AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]

/** Encoder attempts, best-first. PNG (quality-less) is the last resort. */
const ENCODE_ATTEMPTS: ReadonlyArray<{ mime: string; quality?: number }> = [
  { mime: "image/webp", quality: 0.9 },
  { mime: "image/webp", quality: 0.75 },
  { mime: "image/webp", quality: 0.6 },
  { mime: "image/jpeg", quality: 0.85 },
  { mime: "image/jpeg", quality: 0.7 },
  { mime: "image/jpeg", quality: 0.55 },
  { mime: "image/png" },
]

export function isAcceptedAvatarType(mime: string): boolean {
  return ACCEPTED_AVATAR_TYPES.includes(mime)
}

/**
 * Approximate decoded byte length of a `data:` URL's base64 payload. Close
 * enough for cap enforcement (ignores padding, ±2 bytes).
 */
export function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(",")
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  return Math.floor((payload.length * 3) / 4)
}

function decodeImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("could not decode image"))
    }
    img.src = url
  })
}

/**
 * Center-crop the file to a square, downscale to `edge`×`edge`, and encode
 * to the smallest acceptable `data:` URL. Throws when the file type is not
 * accepted, the image cannot be decoded, the canvas is unavailable, or no
 * encoder attempt fits under {@link MAX_AVATAR_BYTES}.
 */
export async function downscaleToDataUrl(
  file: File,
  edge: number = AVATAR_EDGE_PX
): Promise<string> {
  if (!isAcceptedAvatarType(file.type)) {
    throw new Error("unsupported avatar image type")
  }
  const img = await decodeImage(file)
  const sourceW = img.naturalWidth
  const sourceH = img.naturalHeight
  if (!sourceW || !sourceH) {
    throw new Error("could not decode image")
  }

  const canvas = document.createElement("canvas")
  canvas.width = edge
  canvas.height = edge
  const ctx = canvas.getContext("2d")
  if (!ctx) {
    throw new Error("canvas 2d context unavailable")
  }

  // Center-crop the larger axis so the avatar fills the square.
  const cropSize = Math.min(sourceW, sourceH)
  const sx = (sourceW - cropSize) / 2
  const sy = (sourceH - cropSize) / 2
  ctx.drawImage(img, sx, sy, cropSize, cropSize, 0, 0, edge, edge)

  for (const attempt of ENCODE_ATTEMPTS) {
    const dataUrl =
      attempt.quality === undefined
        ? canvas.toDataURL(attempt.mime)
        : canvas.toDataURL(attempt.mime, attempt.quality)
    // Browsers silently fall back to PNG for unsupported encoders — only
    // accept the attempt when the prefix matches what we asked for (the
    // final PNG attempt always matches itself).
    if (!dataUrl.startsWith(`data:${attempt.mime}`)) continue
    if (dataUrlByteLength(dataUrl) <= MAX_AVATAR_BYTES) return dataUrl
  }
  throw new Error("avatar image too large after downscale")
}
