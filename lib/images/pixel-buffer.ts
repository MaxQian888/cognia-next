/**
 * The currency of the image engine: raw RGBA with its dimensions, nothing else.
 *
 * Deliberately structural rather than the DOM `ImageData` class. `ImageData`
 * exists only in a browser/jsdom context, so typing the engine against it would
 * force every pixel test into the slow jsdom project and make the maths
 * untestable in the `node` project that owns `lib/**` `.ts` suites. A plain
 * `{ data, width, height }` satisfies `ImageData` structurally, so a real
 * `ImageData` can be passed straight in and a `PixelBuffer` handed straight to
 * `putImageData`. The boundary costs nothing at runtime.
 */

export interface PixelBuffer {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** A transparent buffer of the given size. */
export function createPixelBuffer(width: number, height: number): PixelBuffer {
  const w = Math.max(1, Math.floor(width))
  const h = Math.max(1, Math.floor(height))
  return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }
}

/** A detached copy. Every transform in this engine is non-mutating. */
export function clonePixelBuffer(buffer: PixelBuffer): PixelBuffer {
  return {
    data: new Uint8ClampedArray(buffer.data),
    width: buffer.width,
    height: buffer.height,
  }
}

/**
 * Whether any pixel is less than fully opaque.
 *
 * Drives the save-format decision: a result carrying transparency must be
 * encoded as PNG, because the WebP quality path the editor otherwise prefers
 * is only reached for opaque frames (and JPEG would composite the alpha onto
 * black without telling anyone).
 */
export function hasTransparency(buffer: PixelBuffer): boolean {
  const { data } = buffer
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true
  }
  return false
}

/** Total pixel count, used for the editor's own resolution ceilings. */
export function pixelCount(buffer: PixelBuffer): number {
  return buffer.width * buffer.height
}

/**
 * Multiply colour by alpha.
 *
 * Every resampling or convolution step has to run in premultiplied space.
 * A fully transparent pixel still carries some arbitrary RGB value, and
 * averaging that value into an opaque neighbour is what produces the dark
 * fringe around soft edges after a blur or a downscale.
 */
export function premultiply(buffer: PixelBuffer): PixelBuffer {
  const out = clonePixelBuffer(buffer)
  const { data } = out
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255
    if (a === 1) continue
    data[i] = data[i] * a
    data[i + 1] = data[i + 1] * a
    data[i + 2] = data[i + 2] * a
  }
  return out
}

/** Divide colour back out of alpha. Mutates and returns `buffer`. */
export function unpremultiply(buffer: PixelBuffer): PixelBuffer {
  const { data } = buffer
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255
    if (a === 1 || a === 0) continue
    const r = data[i] / a
    const g = data[i + 1] / a
    const b = data[i + 2] / a
    data[i] = r > 255 ? 255 : r
    data[i + 1] = g > 255 ? 255 : g
    data[i + 2] = b > 255 ? 255 : b
  }
  return buffer
}
