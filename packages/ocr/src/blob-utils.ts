/**
 * Cross-runtime Blob -> ArrayBuffer reader.
 *
 * Modern browsers, Node 16+, and Tauri's webview all ship `Blob.arrayBuffer()`
 * natively. jsdom (the Jest test runtime) historically does not — its `Blob`
 * implementation only exposes `text()` and `stream()`. This helper transparently
 * falls back to `FileReader` so OCR source-handling code doesn't have to branch
 * on the runtime.
 */

function hasArrayBuffer(blob: Blob): boolean {
  return typeof (blob as { arrayBuffer?: unknown }).arrayBuffer === "function"
}

export async function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (hasArrayBuffer(blob)) {
    return blob.arrayBuffer()
  }
  if (typeof FileReader !== "undefined") {
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => {
        const result = fr.result
        if (result instanceof ArrayBuffer) {
          resolve(result)
        } else {
          reject(new Error("FileReader produced a non-ArrayBuffer result"))
        }
      }
      fr.onerror = () => reject(fr.error ?? new Error("FileReader failed"))
      fr.readAsArrayBuffer(blob)
    })
  }
  // Last-resort fallback: read as text, encode via TextEncoder. Only safe for
  // text payloads — binary blobs land here in degraded environments only.
  const textFn = (blob as { text?: () => Promise<string> }).text
  if (typeof textFn !== "function") {
    throw new Error("Blob has neither arrayBuffer() nor text() — cannot read")
  }
  const text = await textFn.call(blob)
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}
