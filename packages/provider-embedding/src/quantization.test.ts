/**
 * Tests for quantization utilities
 */

import {
  quantizeVector,
  dequantizeVector,
  binarizeVector,
  cosineSimilarityBinary,
} from "./quantization"

describe("quantization", () => {
  it("quantizes and dequantizes vectors", () => {
    const vector = [0, 1, 2]
    const quantized = quantizeVector(vector)
    const dequantized = dequantizeVector(quantized)

    expect(quantized.values).toHaveLength(vector.length)
    expect(dequantized).toHaveLength(vector.length)
  })

  it("binarizes vectors", () => {
    const bits = binarizeVector([-1, 0.5, 0])

    expect(Array.from(bits)).toEqual([0, 1, 1])
  })

  it("computes binary cosine similarity", () => {
    const a = new Uint8Array([1, 0, 1])
    const b = new Uint8Array([1, 0, 1])

    expect(cosineSimilarityBinary(a, b)).toBeCloseTo(1, 5)
  })
})
