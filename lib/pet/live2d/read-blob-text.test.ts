import { readBlobText } from "./read-blob-text"

describe("readBlobText", () => {
  it("uses Blob.text() when available", async () => {
    const blob = { text: async () => "from-text" } as unknown as Blob
    expect(await readBlobText(blob)).toBe("from-text")
  })

  it("falls back to FileReader when Blob.text is missing", async () => {
    // jsdom's Blob has no `.text()`, so a plain Blob exercises the FileReader path.
    const blob = new Blob(["hello world"])
    expect(typeof blob.text).toBe("undefined")
    expect(await readBlobText(blob)).toBe("hello world")
  })

  it("rejects when FileReader errors", async () => {
    const original = FileReader
    class FailingReader {
      result: unknown = null
      error: Error | null = new Error("boom")
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsText() {
        this.onerror?.()
      }
    }
    ;(globalThis as unknown as { FileReader: unknown }).FileReader = FailingReader
    try {
      const blob = { size: 1 } as unknown as Blob
      await expect(readBlobText(blob)).rejects.toThrow("boom")
    } finally {
      ;(globalThis as unknown as { FileReader: unknown }).FileReader = original
    }
  })

  it("rejects with a generic error when FileReader exposes no error", async () => {
    const original = FileReader
    class NoErrorReader {
      result: unknown = null
      error: Error | null = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsText() {
        this.onerror?.()
      }
    }
    ;(globalThis as unknown as { FileReader: unknown }).FileReader = NoErrorReader
    try {
      const blob = { size: 1 } as unknown as Blob
      await expect(readBlobText(blob)).rejects.toThrow("readError")
    } finally {
      ;(globalThis as unknown as { FileReader: unknown }).FileReader = original
    }
  })
})
