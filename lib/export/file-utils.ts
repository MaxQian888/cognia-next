/**
 * Shared file-part helpers for the export renderers under `lib/export/`. Kept in
 * one place so the HTML and text/markdown exporters classify image parts
 * identically instead of drifting between byte-identical private copies.
 */

/** True when a chat file part should render as an image (by MIME, data URL, or extension). */
export function isImageFile(file: {
  url?: string
  mediaType?: string
  filename?: string
}): boolean {
  return Boolean(
    file.mediaType?.startsWith("image/") ||
    file.url?.startsWith("data:image/") ||
    file.filename?.match(/\.(?:avif|gif|jpe?g|png|svg|webp)$/i)
  )
}
