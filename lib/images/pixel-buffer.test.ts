import {
  clonePixelBuffer,
  createPixelBuffer,
  hasTransparency,
  pixelCount,
  pixelIndex,
  premultiply,
  unpremultiply,
  type PixelBuffer,
} from "./pixel-buffer"

function bufferOf(width: number, height: number, fill: number[]): PixelBuffer {
  const buffer = createPixelBuffer(width, height)
  for (let i = 0; i < buffer.data.length; i += 4) {
    buffer.data[i] = fill[0]
    buffer.data[i + 1] = fill[1]
    buffer.data[i + 2] = fill[2]
    buffer.data[i + 3] = fill[3]
  }
  return buffer
}

describe("createPixelBuffer", () => {
  it("allocates four bytes per pixel, fully transparent", () => {
    const buffer = createPixelBuffer(3, 2)
    expect(buffer.width).toBe(3)
    expect(buffer.height).toBe(2)
    expect(buffer.data).toHaveLength(24)
    expect([...buffer.data].every((byte) => byte === 0)).toBe(true)
  })

  it("floors fractional sizes and never allocates a zero-sized frame", () => {
    expect(createPixelBuffer(2.9, 1.2)).toMatchObject({ width: 2, height: 1 })
    expect(createPixelBuffer(0, -4)).toMatchObject({ width: 1, height: 1 })
  })
})

describe("clonePixelBuffer", () => {
  it("copies the pixels into a detached array", () => {
    const original = bufferOf(2, 2, [10, 20, 30, 255])
    const copy = clonePixelBuffer(original)
    copy.data[0] = 99
    expect(original.data[0]).toBe(10)
    expect(copy.width).toBe(2)
  })
})

describe("pixelIndex", () => {
  it("addresses row-major RGBA", () => {
    const buffer = createPixelBuffer(4, 4)
    expect(pixelIndex(buffer, 0, 0)).toBe(0)
    expect(pixelIndex(buffer, 1, 0)).toBe(4)
    expect(pixelIndex(buffer, 0, 1)).toBe(16)
  })
})

describe("hasTransparency", () => {
  it("is false for a fully opaque frame", () => {
    expect(hasTransparency(bufferOf(2, 2, [1, 2, 3, 255]))).toBe(false)
  })

  it("is true when a single pixel is short of opaque", () => {
    const buffer = bufferOf(2, 2, [1, 2, 3, 255])
    buffer.data[7] = 254
    expect(hasTransparency(buffer)).toBe(true)
  })
})

describe("pixelCount", () => {
  it("multiplies the dimensions", () => {
    expect(pixelCount(createPixelBuffer(5, 4))).toBe(20)
  })
})

describe("premultiply and unpremultiply", () => {
  it("leaves opaque pixels untouched", () => {
    const buffer = bufferOf(1, 1, [200, 100, 50, 255])
    expect([...premultiply(buffer).data]).toEqual([200, 100, 50, 255])
  })

  it("scales colour by alpha and restores it", () => {
    const buffer = bufferOf(1, 1, [200, 100, 50, 128])
    const multiplied = premultiply(buffer)
    expect(multiplied.data[0]).toBeCloseTo(200 * (128 / 255), 0)
    const restored = unpremultiply(multiplied)
    expect(restored.data[0]).toBeCloseTo(200, -1)
    expect(restored.data[3]).toBe(128)
  })

  it("does not divide a fully transparent pixel by zero", () => {
    const buffer = bufferOf(1, 1, [200, 100, 50, 0])
    const restored = unpremultiply(premultiply(buffer))
    expect([...restored.data]).toEqual([0, 0, 0, 0])
  })
})
