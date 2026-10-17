/**
 * Paint screencast frames (`decodeRemoteBrowserFrame`) into a canvas — the one
 * draw path behind both streamed browser panes (`LocalChromiumPreview` and
 * `RemoteBrowserPreview`).
 *
 * Newest wins: a frame that arrives while the previous one is still decoding
 * replaces any frame already waiting, and is painted as soon as the decoder is
 * free. Dropping it instead (what the local pane did) could leave the canvas
 * on a stale picture: the screencast only sends frames on damage, so when the
 * last frame of a scroll was the one dropped, nothing came to replace it.
 *
 * The canvas keeps the bitmap's own resolution (Retina frames stay sharp) and
 * is only resized when that resolution changes — assigning `width`/`height`
 * clears and reallocates the backing store even when the value is the same.
 */

import type { RemoteBrowserFrame } from "@/lib/browser/remote-stream"

export interface FramePainter {
  paint: (frame: RemoteBrowserFrame) => void
  dispose: () => void
}

export type DecodeFrameBitmap = (jpeg: Blob) => Promise<ImageBitmap>

const decodeWithBrowser: DecodeFrameBitmap = (jpeg) => createImageBitmap(jpeg)

export function createFramePainter(
  getCanvas: () => HTMLCanvasElement | null,
  decode: DecodeFrameBitmap = decodeWithBrowser
): FramePainter {
  let waiting: RemoteBrowserFrame | null = null
  let painting = false
  let disposed = false

  const pump = async () => {
    painting = true
    try {
      while (waiting && !disposed) {
        const frame = waiting
        waiting = null
        let bitmap: ImageBitmap | null = null
        try {
          // Copy out of the frame's buffer: a view into the IPC buffer is not
          // a valid BlobPart on every engine.
          const jpeg = new Uint8Array(frame.jpeg.byteLength)
          jpeg.set(frame.jpeg)
          bitmap = await decode(new Blob([jpeg.buffer], { type: "image/jpeg" }))
          const canvas = getCanvas()
          if (disposed || !canvas) continue
          if (canvas.width !== bitmap.width) canvas.width = bitmap.width
          if (canvas.height !== bitmap.height) canvas.height = bitmap.height
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
        } catch {
          // A frame that fails to decode is skipped; the next one repaints.
        } finally {
          bitmap?.close()
        }
      }
    } finally {
      painting = false
    }
  }

  return {
    paint(frame) {
      if (disposed) return
      waiting = frame
      if (!painting) void pump()
    },
    dispose() {
      disposed = true
      waiting = null
    },
  }
}
