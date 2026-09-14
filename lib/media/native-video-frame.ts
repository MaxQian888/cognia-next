/**
 * The wire shape of `plugin_media_get_video_frame`: an 8-byte little-endian
 * header (`u32 width`, `u32 height`) followed by `width × height × 4` RGBA
 * bytes (`pack_frame_response` in `crates/cognia-media`).
 *
 * Shared by the plugin Media API and the composer's desktop video fallback, so
 * the two readers of one Rust response cannot drift apart.
 */

import type { PixelBuffer } from "@/lib/images/pixel-buffer"

/** A fresh copy, so its buffer is a plain `ArrayBuffer` that `ImageData` accepts. */
export type NativeVideoFrame = PixelBuffer & { data: Uint8ClampedArray<ArrayBuffer> }

export function decodeNativeVideoFrame(
  response: ArrayBuffer | Uint8Array | number[]
): NativeVideoFrame {
  const bytes =
    response instanceof Uint8Array
      ? response
      : Array.isArray(response)
        ? Uint8Array.from(response)
        : new Uint8Array(response)
  if (bytes.byteLength < 8) {
    throw new Error("Native video frame response is missing its dimension header")
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(0, true)
  const height = view.getUint32(4, true)
  if (width === 0 || height === 0) {
    throw new Error("Native video frame response has invalid dimensions")
  }
  const expectedLength = width * height * 4
  if (bytes.byteLength !== expectedLength + 8) {
    throw new Error(
      `Native video frame response has ${bytes.byteLength - 8} pixels bytes; expected ${expectedLength}`
    )
  }
  return { data: new Uint8ClampedArray(bytes.slice(8)), width, height }
}
