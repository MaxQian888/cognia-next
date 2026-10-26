/** @jest-environment jsdom */

import { createFramePainter } from "@/lib/browser/frame-painter"
import type { RemoteBrowserFrame } from "@/lib/browser/remote-stream"

function frame(sequence: number): RemoteBrowserFrame {
  return {
    version: 1,
    codec: "jpeg",
    sequence,
    width: 800,
    height: 600,
    timestamp: 0,
    // The payload's length identifies the frame through the Blob.
    jpeg: new Uint8Array(sequence),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fakeBitmap(width: number, height: number, label: number) {
  return { width, height, label, close: jest.fn() } as unknown as ImageBitmap & {
    label: number
    close: jest.Mock
  }
}

function fakeCanvas() {
  const canvas = document.createElement("canvas")
  const drawImage = jest.fn()
  Object.defineProperty(canvas, "getContext", { value: () => ({ drawImage }) })
  let widthWrites = 0
  let width = 300
  Object.defineProperty(canvas, "width", {
    get: () => width,
    set: (value: number) => {
      widthWrites += 1
      width = value
    },
  })
  return { canvas, drawImage, widthWrites: () => widthWrites }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("createFramePainter", () => {
  it("rechecks frame eligibility after decoding and reports only a painted frame", async () => {
    const { canvas, drawImage } = fakeCanvas()
    const pending = deferred<ImageBitmap>()
    const bitmap = fakeBitmap(800, 600, 1)
    let eligible = true
    const onPaint = jest.fn()
    const painter = createFramePainter(
      () => canvas,
      () => pending.promise,
      {
        canPaint: () => eligible,
        onPaint,
      }
    )
    painter.paint(frame(1))
    eligible = false
    pending.resolve(bitmap)
    await flush()
    expect(drawImage).not.toHaveBeenCalled()
    expect(onPaint).not.toHaveBeenCalled()
    expect(bitmap.close).toHaveBeenCalledTimes(1)
  })

  it("updates frame metadata only after a successful draw", async () => {
    const { canvas, drawImage } = fakeCanvas()
    const onPaint = jest.fn()
    const painter = createFramePainter(
      () => canvas,
      async () => fakeBitmap(800, 600, 1),
      {
        onPaint,
      }
    )
    const next = frame(1)
    painter.paint(next)
    await flush()
    expect(onPaint).toHaveBeenCalledWith(next)
    expect(onPaint.mock.invocationCallOrder[0]).toBeGreaterThan(
      drawImage.mock.invocationCallOrder[0]
    )
  })

  it.each(["missing context", "failed draw"])(
    "does not report a painted frame after %s",
    async (failure) => {
      const canvas = document.createElement("canvas")
      Object.defineProperty(canvas, "getContext", {
        value: () =>
          failure === "missing context"
            ? null
            : {
                drawImage: () => {
                  throw new Error("draw failed")
                },
              },
      })
      const bitmap = fakeBitmap(800, 600, 1)
      const onPaint = jest.fn()
      const painter = createFramePainter(
        () => canvas,
        async () => bitmap,
        { onPaint }
      )
      painter.paint(frame(1))
      await flush()
      expect(onPaint).not.toHaveBeenCalled()
      expect(bitmap.close).toHaveBeenCalledTimes(1)
    }
  )

  it("paints at the bitmap's own resolution", async () => {
    const { canvas, drawImage } = fakeCanvas()
    const bitmap = fakeBitmap(1600, 1200, 1)
    const painter = createFramePainter(
      () => canvas,
      async () => bitmap
    )
    painter.paint(frame(1))
    await flush()
    expect(canvas.width).toBe(1600)
    expect(canvas.height).toBe(1200)
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0)
    expect(bitmap.close).toHaveBeenCalled()
  })

  it("paints the newest frame that arrived during a decode instead of dropping it", async () => {
    const { canvas, drawImage } = fakeCanvas()
    const first = deferred<ImageBitmap>()
    const decoded: number[] = []
    const decode = jest.fn(async (blob: Blob) => {
      const label = blob.size
      decoded.push(label)
      return label === 1 ? first.promise : fakeBitmap(800, 600, label)
    })
    const painter = createFramePainter(() => canvas, decode)
    painter.paint(frame(1))
    await flush()
    // Two frames land while frame 1 is decoding: only the newest is kept.
    painter.paint(frame(2))
    painter.paint(frame(3))
    first.resolve(fakeBitmap(800, 600, 1))
    await flush()
    await flush()
    expect(decoded).toEqual([1, 3])
    const painted = drawImage.mock.calls.map(([bitmap]) => (bitmap as { label: number }).label)
    expect(painted).toEqual([1, 3])
  })

  it("resizes the canvas only when the frame resolution changes", async () => {
    const { canvas, widthWrites } = fakeCanvas()
    const painter = createFramePainter(
      () => canvas,
      async () => fakeBitmap(800, 600, 0)
    )
    painter.paint(frame(1))
    await flush()
    painter.paint(frame(2))
    await flush()
    expect(widthWrites()).toBe(1)
  })

  it("skips a frame that fails to decode and keeps painting later ones", async () => {
    const { canvas, drawImage } = fakeCanvas()
    const decode = jest
      .fn()
      .mockRejectedValueOnce(new Error("corrupt"))
      .mockResolvedValue(fakeBitmap(800, 600, 2))
    const painter = createFramePainter(() => canvas, decode)
    painter.paint(frame(1))
    await flush()
    painter.paint(frame(2))
    await flush()
    expect(drawImage).toHaveBeenCalledTimes(1)
  })

  it("stops painting once disposed", async () => {
    const { canvas, drawImage } = fakeCanvas()
    const pending = deferred<ImageBitmap>()
    const bitmap = fakeBitmap(800, 600, 1)
    const painter = createFramePainter(
      () => canvas,
      () => pending.promise
    )
    painter.paint(frame(1))
    painter.dispose()
    pending.resolve(bitmap)
    await flush()
    painter.paint(frame(2))
    await flush()
    expect(drawImage).not.toHaveBeenCalled()
    expect(bitmap.close).toHaveBeenCalled()
  })
})
