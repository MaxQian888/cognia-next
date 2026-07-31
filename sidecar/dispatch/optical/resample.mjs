// Separable Lanczos3 resampling for the optical renderer's "stretch" shapes.
//
// Ports `lanczos3` / `contributions` / `resize_rgb` from snapcompact.rs
// (PIL convention: center = (i + 0.5) * scale, kernel stretched by
// max(scale, 1), weights normalized). Used when the target cell differs from
// the font's natural cell, e.g. the OpenAI-optimal "6x6u" shape.

const PI = Math.PI

export function lanczos3(x) {
  x = Math.abs(x)
  if (x < 1e-6) return 1
  if (x >= 3) return 0
  const pix = PI * x
  return (Math.sin(pix) / pix) * (Math.sin(pix / 3) / (pix / 3))
}

/** Per-output-pixel kernel contributions for one axis: `[begin, weights][]`. */
export function contributions(srcLen, dstLen) {
  const scale = srcLen / dstLen
  const filtScale = Math.max(scale, 1)
  const support = 3 * filtScale
  const out = []
  for (let i = 0; i < dstLen; i++) {
    const center = (i + 0.5) * scale
    const begin = Math.max(0, Math.trunc(center - support))
    const end = Math.min(srcLen, Math.ceil(center + support))
    const weights = []
    let total = 0
    for (let x = begin; x < end; x++) {
      const w = lanczos3((x + 0.5 - center) / filtScale)
      weights.push(w)
      total += w
    }
    if (total !== 0) {
      for (let k = 0; k < weights.length; k++) weights[k] /= total
    }
    out.push([begin, weights])
  }
  return out
}

/**
 * Separable Lanczos3 resize of an interleaved RGB f32 buffer.
 * @param {Float32Array} src
 * @returns {Float32Array}
 */
export function resizeRgb(src, sw, sh, dw, dh) {
  const horiz = contributions(sw, dw)
  const tmp = new Float32Array(dw * sh * 3)
  for (let y = 0; y < sh; y++) {
    const srcBase = y * sw * 3
    const dstBase = y * dw * 3
    for (let x = 0; x < dw; x++) {
      const [begin, weights] = horiz[x]
      let a0 = 0
      let a1 = 0
      let a2 = 0
      for (let k = 0; k < weights.length; k++) {
        const s = srcBase + (begin + k) * 3
        const w = weights[k]
        a0 += src[s] * w
        a1 += src[s + 1] * w
        a2 += src[s + 2] * w
      }
      tmp[dstBase + x * 3] = a0
      tmp[dstBase + x * 3 + 1] = a1
      tmp[dstBase + x * 3 + 2] = a2
    }
  }
  const vert = contributions(sh, dh)
  const out = new Float32Array(dw * dh * 3)
  for (let y = 0; y < dh; y++) {
    const [begin, weights] = vert[y]
    const dstBase = y * dw * 3
    for (let k = 0; k < weights.length; k++) {
      const srcBase = (begin + k) * dw * 3
      const w = weights[k]
      for (let d = 0; d < dw * 3; d++) out[dstBase + d] += tmp[srcBase + d] * w
    }
  }
  return out
}
