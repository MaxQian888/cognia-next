import { pad, padmeLength, unpad } from "./padding"

describe("PADMÉ", () => {
  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [9, 10],
    [100, 104],
    [1000, 1024],
    [1025, 1088],
    [65_537, 67_584],
  ])("buckets %i bytes as %i", (length, bucket) => {
    expect(padmeLength(length)).toBe(bucket)
    expect(padmeLength(length)).toBeGreaterThanOrEqual(length)
  })

  it("loses little: the overhead stays under 12% past 256 bytes", () => {
    for (let length = 256; length < 200_000; length += 997) {
      expect(padmeLength(length) / length).toBeLessThan(1.12)
    }
  })

  it("round-trips, including trailing zeros and empty plaintext", () => {
    for (const plaintext of [
      new Uint8Array(),
      new Uint8Array([0, 0, 0]),
      new Uint8Array([1, 0x80, 0]),
      new Uint8Array(1000).fill(7),
    ]) {
      const padded = pad(plaintext)
      expect(padded.length).toBe(padmeLength(plaintext.length + 1))
      expect(unpad(padded)).toEqual(plaintext)
    }
  })

  it("refuses bad padding and bad lengths", () => {
    expect(() => unpad(new Uint8Array([1, 2, 0]))).toThrow(RangeError)
    expect(() => unpad(new Uint8Array([0, 0]))).toThrow(RangeError)
    expect(() => padmeLength(-1)).toThrow(RangeError)
    expect(() => padmeLength(1.5)).toThrow(RangeError)
  })
})
