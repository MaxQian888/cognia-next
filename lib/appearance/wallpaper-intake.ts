// Client-side validation for a picked/dropped wallpaper file, shared by every
// entry point that accepts one: the uploader's own picker and dropzone, and
// the gallery grid's drop target. Lives here rather than inside the uploader
// component so a second intake surface can't drift from the first.
//
// Returns a discriminated result instead of throwing: rejects are expected
// user input (wrong file type, too big), not exceptions.

import { MAX_WALLPAPER_BYTES } from "./wallpaper-storage"
import { readImageDimensions } from "./image-utils"

export const ACCEPTED_WALLPAPER_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
] as const

export interface UploadedWallpaper {
  bytes: ArrayBuffer
  mime: string
  width: number
  height: number
  /** Original `File.name`. Caller may use it for the wallpaper display name. */
  fileName: string
}

/** Why a file was rejected. Maps 1:1 to a `settings.appearance.wallpaper` key. */
export type WallpaperRejection = "invalidType" | "tooLarge"

export type WallpaperIntakeResult =
  { ok: true; file: UploadedWallpaper } | { ok: false; reason: WallpaperRejection }

export function isAcceptedWallpaperType(mime: string): boolean {
  return (ACCEPTED_WALLPAPER_MIMES as readonly string[]).includes(mime)
}

/**
 * Validate a `File` and read it into an `UploadedWallpaper`. Size and type are
 * checked before the bytes are read, so an oversized file is rejected without
 * being pulled into memory.
 */
export async function intakeWallpaperFile(file: File): Promise<WallpaperIntakeResult> {
  if (!isAcceptedWallpaperType(file.type)) return { ok: false, reason: "invalidType" }
  if (file.size > MAX_WALLPAPER_BYTES) return { ok: false, reason: "tooLarge" }
  const [bytes, dims] = await Promise.all([file.arrayBuffer(), readImageDimensions(file)])
  return {
    ok: true,
    file: { bytes, mime: file.type, width: dims.width, height: dims.height, fileName: file.name },
  }
}
