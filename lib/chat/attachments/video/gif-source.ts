/**
 * The GIF engine: `lib/images/gif.ts` behind the frame-source contract.
 *
 * Opening returns `null` for a GIF with one frame. A still GIF is an image,
 * and it leaves the motion pipeline for the ordinary image path — the caller
 * must not storyboard a picture.
 */

import {
  GifDecodeError,
  composeGifFrames,
  gifFrameIndexAt,
  parseGifTimeline,
} from "@/lib/images/gif"
import type { PixelBuffer } from "@/lib/images/pixel-buffer"
import { fitBuffer } from "./storyboard"
import {
  NativeVideoPrepareError,
  VideoPreprocessError,
  throwIfAborted,
  type MotionFrameSource,
} from "./frame-source"

export async function openGifFrameSource(blob: Blob): Promise<MotionFrameSource | null> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let timeline
  try {
    timeline = parseGifTimeline(bytes)
  } catch (error) {
    throw new VideoPreprocessError(
      "undecodable",
      error instanceof GifDecodeError ? error.message : "GIF could not be parsed",
      "not-tried"
    )
  }
  if (timeline.frames.length <= 1) return null

  const indexAt = (timeSec: number) => gifFrameIndexAt(timeline, timeSec * 1000)

  return {
    engine: "gif",
    info: {
      kind: "gif",
      mediaType: "image/gif",
      durationSec: timeline.durationMs / 1000,
      width: timeline.width,
      height: timeline.height,
      frameCount: timeline.frames.length,
    },
    frameKeyAt: indexAt,
    async grab(times, box, options = {}) {
      throwIfAborted(options.signal)
      const indices = times.map(indexAt)
      const captured = composeGifFrames(bytes, timeline, { capture: new Set(indices) })
      const fitted = new Map<number, PixelBuffer>()
      return indices.map((index) => {
        let frame = fitted.get(index)
        if (!frame) {
          frame = fitBuffer(captured.get(index)!, box.maxWidth, box.maxHeight)
          fitted.set(index, frame)
        }
        options.onFrame?.()
        return frame
      })
    },
    async readNative() {
      throw new NativeVideoPrepareError(
        "format",
        "no video-capable provider accepts a GIF as a video file"
      )
    },
    async close() {},
  }
}
