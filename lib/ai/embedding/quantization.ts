/**
 * Vector Quantization Utilities
 * Simple scalar and binary quantization helpers.
 */

export interface QuantizationConfig {
  bits?: number
}

export interface QuantizedVector {
  scale: number
  zeroPoint: number
  values: Uint8Array
}

const DEFAULT_BITS = 8

export function quantizeVector(vector: number[], config: QuantizationConfig = {}): QuantizedVector {
  const bits = config.bits ?? DEFAULT_BITS
  const levels = 2 ** bits - 1
  const min = Math.min(...vector)
  const max = Math.max(...vector)
  const scale = max === min ? 1 : (max - min) / levels
  const zeroPoint = scale === 0 ? 0 : Math.round(-min / scale)

  const values = new Uint8Array(vector.length)
  for (let i = 0; i < vector.length; i++) {
    const quantized = Math.round(vector[i] / scale) + zeroPoint
    values[i] = Math.min(levels, Math.max(0, quantized))
  }

  return { scale, zeroPoint, values }
}

export function dequantizeVector(quantized: QuantizedVector): number[] {
  const { scale, zeroPoint, values } = quantized
  const vector = new Array(values.length)
  for (let i = 0; i < values.length; i++) {
    vector[i] = (values[i] - zeroPoint) * scale
  }
  return vector
}

export function binarizeVector(vector: number[]): Uint8Array {
  const bits = new Uint8Array(vector.length)
  for (let i = 0; i < vector.length; i++) {
    bits[i] = vector[i] >= 0 ? 1 : 0
  }
  return bits
}

export function cosineSimilarityBinary(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let sumA = 0
  let sumB = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i]
    const bv = b[i]
    dot += av * bv
    sumA += av
    sumB += bv
  }
  const denom = Math.sqrt(sumA) * Math.sqrt(sumB)
  return denom === 0 ? 0 : dot / denom
}
