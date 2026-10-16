/**
 * The image work behind agent screenshots: size, crop and stitch PNG captures.
 *
 * `chrome.tabs.captureVisibleTab` answers a data URL of the visible area and
 * nothing else, so an element shot is a crop of it and a full-page shot is a
 * stack of them. A service worker has no DOM, so this is `OffscreenCanvas`
 * and `createImageBitmap` — injected, so the arithmetic runs under Jest where
 * neither exists.
 */

export interface ImageSurface {
  getContext(type: "2d"): {
    drawImage(
      image: unknown,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number
    ): void
  } | null
  convertToBlob(options: { type: string }): Promise<Blob>
}

export interface Bitmap {
  width: number
  height: number
  close?(): void
}

export interface ImageOpsDeps {
  decode: (blob: Blob) => Promise<Bitmap>
  surface: (width: number, height: number) => ImageSurface
}

/** Largest canvas side Chrome draws reliably; a taller full page is cut here. */
export const MAX_CANVAS_SIDE = 16_384

export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",")
  if (!dataUrl.startsWith("data:") || comma < 0) throw new Error("not a data URL")
  const header = dataUrl.slice(5, comma)
  const type = header.split(";")[0] || "application/octet-stream"
  const payload = dataUrl.slice(comma + 1)
  if (!header.endsWith(";base64")) return new Blob([decodeURIComponent(payload)], { type })
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type })
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  // Chunked: `String.fromCharCode(...bytes)` overflows the argument limit on a
  // capture of a few megabytes.
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function context(surface: ImageSurface) {
  const ctx = surface.getContext("2d")
  if (!ctx) throw new Error("no 2d canvas context")
  return ctx
}

export function createImageOps(deps: ImageOpsDeps) {
  async function decode(dataUrl: string): Promise<Bitmap> {
    return deps.decode(dataUrlToBlob(dataUrl))
  }

  return {
    async size(dataUrl: string) {
      const bitmap = await decode(dataUrl)
      const size = { width: bitmap.width, height: bitmap.height }
      bitmap.close?.()
      return size
    },

    async crop(dataUrl: string, rect: { x: number; y: number; width: number; height: number }) {
      const bitmap = await decode(dataUrl)
      // An element partly off screen crops to what was captured.
      const x = Math.min(Math.max(0, rect.x), Math.max(0, bitmap.width - 1))
      const y = Math.min(Math.max(0, rect.y), Math.max(0, bitmap.height - 1))
      const width = Math.max(1, Math.min(rect.width, bitmap.width - x))
      const height = Math.max(1, Math.min(rect.height, bitmap.height - y))
      const surface = deps.surface(width, height)
      context(surface).drawImage(bitmap, x, y, width, height, 0, 0, width, height)
      bitmap.close?.()
      return blobToBase64(await surface.convertToBlob({ type: "image/png" }))
    },

    /**
     * Stack captures top to bottom. Each contributes its BOTTOM `heights[i]`
     * rows: a segment that could not scroll a full viewport overlaps the one
     * before it, and the rows it adds are the ones the previous did not show.
     */
    async stitch(dataUrls: string[], width: number, heights: number[]) {
      const total = Math.min(
        MAX_CANVAS_SIDE,
        heights.reduce((sum, rows) => sum + rows, 0)
      )
      const surface = deps.surface(Math.min(MAX_CANVAS_SIDE, width), Math.max(1, total))
      const ctx = context(surface)
      let top = 0
      for (let index = 0; index < dataUrls.length && top < total; index++) {
        const bitmap = await decode(dataUrls[index]!)
        const rows = Math.min(heights[index] ?? 0, bitmap.height, total - top)
        if (rows > 0) {
          const sourceY = bitmap.height - rows
          const columns = Math.min(width, bitmap.width)
          ctx.drawImage(bitmap, 0, sourceY, columns, rows, 0, top, columns, rows)
          top += rows
        }
        bitmap.close?.()
      }
      return blobToBase64(await surface.convertToBlob({ type: "image/png" }))
    },
  }
}

/** The service worker's real canvas. */
export function browserImageOps() {
  return createImageOps({
    decode: (blob) => createImageBitmap(blob),
    surface: (width, height) => new OffscreenCanvas(width, height) as unknown as ImageSurface,
  })
}
