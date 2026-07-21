/** @jest-environment jsdom */

import { readBlobAsArrayBuffer } from "./blob-utils"

describe("readBlobAsArrayBuffer", () => {
  it("uses Blob.arrayBuffer when available", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const blob = new Blob([bytes])
    const arrayBufferMock = jest.fn(async () => bytes.buffer as ArrayBuffer)
    ;(blob as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = arrayBufferMock
    const buf = await readBlobAsArrayBuffer(blob)
    expect(arrayBufferMock).toHaveBeenCalledTimes(1)
    expect(new Uint8Array(buf)).toEqual(bytes)
  })

  it("falls back to FileReader when arrayBuffer is missing", async () => {
    const bytes = new Uint8Array([4, 5, 6, 7])
    const blob = new Blob([bytes])
    // Force the polyfill path
    Object.defineProperty(blob, "arrayBuffer", {
      value: undefined,
      configurable: true,
    })
    const buf = await readBlobAsArrayBuffer(blob)
    expect(new Uint8Array(buf)).toEqual(bytes)
  })

  it("propagates FileReader errors", async () => {
    const blob = new Blob([new Uint8Array([1])])
    Object.defineProperty(blob, "arrayBuffer", {
      value: undefined,
      configurable: true,
    })
    const original = globalThis.FileReader
    class BrokenFileReader {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      error = new Error("broken")
      result: unknown = null
      readAsArrayBuffer() {
        setTimeout(() => this.onerror?.(), 0)
      }
    }
    ;(globalThis as unknown as { FileReader: unknown }).FileReader = BrokenFileReader
    try {
      await expect(readBlobAsArrayBuffer(blob)).rejects.toThrow(/broken/)
    } finally {
      ;(globalThis as unknown as { FileReader: unknown }).FileReader = original
    }
  })
})
/** @jest-environment jsdom */
