/**
 * Geometry operations on pixels: crop, resize, quarter turns, flips, and the
 * arbitrary-angle composite the plugin Media API exposes.
 *
 * All of it is pure and canvas-free, for two reasons. It stays testable in the
 * fast `node` Jest project, and it stays deterministic: a canvas `drawImage`
 * resample is whatever the host's Skia build decides to do that day, so two
 * shells could disagree about the bytes of the same edit, and the editor
 * content-addresses its results.
 */

import {
  clonePixelBuffer,
  createPixelBuffer,
  premultiply,
  unpremultiply,
  type PixelBuffer,
} from "./pixel-buffer"

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export interface FlipOptions {
  horizontal?: boolean
  vertical?: boolean
}

/** Plugin-facing transform options, kept name-compatible with the Media API. */
export interface TransformOptions {
  /** Degrees, clockwise, about the centre. */
  rotate?: number
  flipHorizontal?: boolean
  flipVertical?: boolean
  scale?: number
  cropRegion?: CropRect
}

/**
 * Cut `rect` out of `buffer`.
 *
 * The rect is intersected with the frame rather than rejected when it hangs
 * over an edge: the crop UI works in float coordinates over a zoomed preview,
 * so a rect that lands half a pixel outside is normal, not a bug. Area outside
 * the source stays transparent.
 */
export function cropBuffer(buffer: PixelBuffer, rect: CropRect): PixelBuffer {
  const x = Math.round(rect.x)
  const y = Math.round(rect.y)
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  const out = createPixelBuffer(width, height)

  const startX = Math.max(0, -x)
  const startY = Math.max(0, -y)
  const endX = Math.min(width, buffer.width - x)
  const endY = Math.min(height, buffer.height - y)

  for (let row = startY; row < endY; row += 1) {
    const sourceRow = (y + row) * buffer.width
    const targetRow = row * width
    for (let column = startX; column < endX; column += 1) {
      const source = (sourceRow + x + column) * 4
      const target = (targetRow + column) * 4
      out.data[target] = buffer.data[source]
      out.data[target + 1] = buffer.data[source + 1]
      out.data[target + 2] = buffer.data[source + 2]
      out.data[target + 3] = buffer.data[source + 3]
    }
  }
  return out
}

/**
 * Resample to `width` x `height`.
 *
 * Separable, one axis at a time, and the kernel is chosen per axis: a box
 * filter that averages the whole source span when shrinking, linear
 * interpolation when growing. Bilinear alone would point-sample a large
 * downscale and alias badly, which matters here because the editor's own
 * "fit to canonical 1568px" pass is a downscale.
 */
export function resizeBuffer(buffer: PixelBuffer, width: number, height: number): PixelBuffer {
  const targetWidth = Math.max(1, Math.round(width))
  const targetHeight = Math.max(1, Math.round(height))
  if (targetWidth === buffer.width && targetHeight === buffer.height) {
    return clonePixelBuffer(buffer)
  }
  const premultiplied = premultiply(buffer)
  const horizontal = resampleAxis(premultiplied, targetWidth, true)
  const both = resampleAxis(horizontal, targetHeight, false)
  return unpremultiply(both)
}

function resampleAxis(source: PixelBuffer, targetLength: number, horizontal: boolean): PixelBuffer {
  const sourceLength = horizontal ? source.width : source.height
  const otherLength = horizontal ? source.height : source.width
  const out = horizontal
    ? createPixelBuffer(targetLength, source.height)
    : createPixelBuffer(source.width, targetLength)
  const weightsPerOutput = axisWeights(sourceLength, targetLength)

  for (let other = 0; other < otherLength; other += 1) {
    for (let position = 0; position < targetLength; position += 1) {
      const weights = weightsPerOutput[position]
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let w = 0; w < weights.length; w += 2) {
        const index = horizontal
          ? (other * source.width + weights[w]) * 4
          : (weights[w] * source.width + other) * 4
        const weight = weights[w + 1]
        r += source.data[index] * weight
        g += source.data[index + 1] * weight
        b += source.data[index + 2] * weight
        a += source.data[index + 3] * weight
      }
      const target = horizontal
        ? (other * out.width + position) * 4
        : (position * out.width + other) * 4
      out.data[target] = r
      out.data[target + 1] = g
      out.data[target + 2] = b
      out.data[target + 3] = a
    }
  }
  return out
}

/**
 * Flat `[sourceIndex, weight, sourceIndex, weight, ...]` per output position.
 *
 * Computed once per axis rather than per pixel: for a 1568px frame that is 1568
 * weight lists reused across every row, instead of two million recomputations.
 */
function axisWeights(sourceLength: number, targetLength: number): number[][] {
  const scale = sourceLength / targetLength
  const result: number[][] = new Array(targetLength)

  for (let position = 0; position < targetLength; position += 1) {
    const weights: number[] = []
    if (scale > 1) {
      // Shrinking: average every source pixel the output pixel covers, with
      // fractional weights at the two ends of the span.
      const start = position * scale
      const end = start + scale
      const first = Math.floor(start)
      const last = Math.min(sourceLength - 1, Math.ceil(end) - 1)
      let total = 0
      for (let index = first; index <= last; index += 1) {
        const overlap = Math.min(end, index + 1) - Math.max(start, index)
        if (overlap <= 0) continue
        weights.push(index, overlap)
        total += overlap
      }
      if (total > 0) {
        for (let w = 1; w < weights.length; w += 2) weights[w] /= total
      }
    } else {
      // Growing: linear interpolation between the two nearest source centres.
      const centre = (position + 0.5) * scale - 0.5
      const left = Math.floor(centre)
      const fraction = centre - left
      const leftIndex = Math.min(sourceLength - 1, Math.max(0, left))
      const rightIndex = Math.min(sourceLength - 1, Math.max(0, left + 1))
      if (fraction <= 0) weights.push(leftIndex, 1)
      else if (fraction >= 1) weights.push(rightIndex, 1)
      else weights.push(leftIndex, 1 - fraction, rightIndex, fraction)
    }
    result[position] = weights.length > 0 ? weights : [0, 1]
  }
  return result
}

/**
 * Rotate by whole quarter turns, clockwise.
 *
 * Kept separate from the arbitrary-angle path because it is exact: every output
 * pixel is one input pixel moved, with no resampling and no loss. That is what
 * the workbench's rotate-left and rotate-right buttons use, so a user can spin
 * an image four times and get the original bytes back.
 */
export function rotateQuarterTurns(buffer: PixelBuffer, turns: number): PixelBuffer {
  const normalized = ((Math.round(turns) % 4) + 4) % 4
  if (normalized === 0) return clonePixelBuffer(buffer)

  const swapped = normalized % 2 === 1
  const width = swapped ? buffer.height : buffer.width
  const height = swapped ? buffer.width : buffer.height
  const out = createPixelBuffer(width, height)

  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      let targetX: number
      let targetY: number
      if (normalized === 1) {
        targetX = buffer.height - 1 - y
        targetY = x
      } else if (normalized === 2) {
        targetX = buffer.width - 1 - x
        targetY = buffer.height - 1 - y
      } else {
        targetX = y
        targetY = buffer.width - 1 - x
      }
      const source = (y * buffer.width + x) * 4
      const target = (targetY * width + targetX) * 4
      out.data[target] = buffer.data[source]
      out.data[target + 1] = buffer.data[source + 1]
      out.data[target + 2] = buffer.data[source + 2]
      out.data[target + 3] = buffer.data[source + 3]
    }
  }
  return out
}

/** Mirror horizontally, vertically, or both. Exact, like the quarter turns. */
export function flipBuffer(
  buffer: PixelBuffer,
  { horizontal, vertical }: FlipOptions
): PixelBuffer {
  if (!horizontal && !vertical) return clonePixelBuffer(buffer)
  const out = createPixelBuffer(buffer.width, buffer.height)
  for (let y = 0; y < buffer.height; y += 1) {
    const sourceY = vertical ? buffer.height - 1 - y : y
    for (let x = 0; x < buffer.width; x += 1) {
      const sourceX = horizontal ? buffer.width - 1 - x : x
      const source = (sourceY * buffer.width + sourceX) * 4
      const target = (y * buffer.width + x) * 4
      out.data[target] = buffer.data[source]
      out.data[target + 1] = buffer.data[source + 1]
      out.data[target + 2] = buffer.data[source + 2]
      out.data[target + 3] = buffer.data[source + 3]
    }
  }
  return out
}

/**
 * Rotate by an arbitrary angle about the centre, keeping the original frame
 * size, sampling bilinearly.
 *
 * Frame size is preserved rather than expanded because that is the contract the
 * plugin Media API already shipped, and a plugin that rotates a tile by 7
 * degrees expects a tile back. Corners rotate out of frame and are lost. The
 * workbench never calls this: its rotate buttons are quarter turns.
 */
export function rotateBuffer(buffer: PixelBuffer, degrees: number): PixelBuffer {
  if (degrees % 360 === 0) return clonePixelBuffer(buffer)
  if (degrees % 90 === 0) return sameSizeQuarterTurn(buffer, degrees)

  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(-radians)
  const sin = Math.sin(-radians)
  const centreX = buffer.width / 2
  const centreY = buffer.height / 2
  const premultiplied = premultiply(buffer)
  const out = createPixelBuffer(buffer.width, buffer.height)

  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      const dx = x + 0.5 - centreX
      const dy = y + 0.5 - centreY
      const sourceX = dx * cos - dy * sin + centreX - 0.5
      const sourceY = dx * sin + dy * cos + centreY - 0.5
      const target = (y * buffer.width + x) * 4
      sampleBilinear(premultiplied, sourceX, sourceY, out.data, target)
    }
  }
  return unpremultiply(out)
}

/**
 * A 90/180/270 rotation that must keep the original frame, which for a
 * non-square image means the rotated content is cropped to the old bounds.
 * Routed away from the bilinear path so the pixels stay exact.
 */
function sameSizeQuarterTurn(buffer: PixelBuffer, degrees: number): PixelBuffer {
  const turns = ((Math.round(degrees / 90) % 4) + 4) % 4
  const rotated = rotateQuarterTurns(buffer, turns)
  if (rotated.width === buffer.width && rotated.height === buffer.height) return rotated
  return cropBuffer(rotated, {
    x: Math.round((rotated.width - buffer.width) / 2),
    y: Math.round((rotated.height - buffer.height) / 2),
    width: buffer.width,
    height: buffer.height,
  })
}

function sampleBilinear(
  source: PixelBuffer,
  x: number,
  y: number,
  target: Uint8ClampedArray,
  offset: number
): void {
  if (x < -1 || y < -1 || x > source.width || y > source.height) return
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0

  for (let channel = 0; channel < 4; channel += 1) {
    const topLeft = sampleChannel(source, x0, y0, channel)
    const topRight = sampleChannel(source, x0 + 1, y0, channel)
    const bottomLeft = sampleChannel(source, x0, y0 + 1, channel)
    const bottomRight = sampleChannel(source, x0 + 1, y0 + 1, channel)
    const top = topLeft + (topRight - topLeft) * fx
    const bottom = bottomLeft + (bottomRight - bottomLeft) * fx
    target[offset + channel] = top + (bottom - top) * fy
  }
}

/** Outside the frame reads as transparent, so rotated corners fade out. */
function sampleChannel(source: PixelBuffer, x: number, y: number, channel: number): number {
  if (x < 0 || y < 0 || x >= source.width || y >= source.height) return 0
  return source.data[(y * source.width + x) * 4 + channel]
}

/**
 * The plugin Media API's composite transform, in its original order: rotate and
 * scale about the centre, then flips, then crop.
 */
export function transformBuffer(buffer: PixelBuffer, options: TransformOptions): PixelBuffer {
  let result = clonePixelBuffer(buffer)

  if (options.rotate) {
    result = rotateBuffer(result, options.rotate)
  }
  if (options.scale && options.scale !== 1) {
    result = scaleAboutCentre(result, options.scale)
  }
  if (options.flipHorizontal || options.flipVertical) {
    result = flipBuffer(result, {
      horizontal: options.flipHorizontal,
      vertical: options.flipVertical,
    })
  }
  if (options.cropRegion) {
    result = cropBuffer(result, options.cropRegion)
  }
  return result
}

/**
 * Scale content within an unchanged frame, so scaling up crops and scaling down
 * leaves transparent margins. This mirrors the canvas `ctx.scale` the plugin
 * transform used before the engine existed.
 */
function scaleAboutCentre(buffer: PixelBuffer, scale: number): PixelBuffer {
  const scaledWidth = Math.max(1, Math.round(buffer.width * scale))
  const scaledHeight = Math.max(1, Math.round(buffer.height * scale))
  const scaled = resizeBuffer(buffer, scaledWidth, scaledHeight)
  return cropBuffer(scaled, {
    x: Math.round((scaledWidth - buffer.width) / 2),
    y: Math.round((scaledHeight - buffer.height) / 2),
    width: buffer.width,
    height: buffer.height,
  })
}
