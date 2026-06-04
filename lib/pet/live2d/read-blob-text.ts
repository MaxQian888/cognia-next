// Reads a Blob as UTF-8 text portably. Real browsers (and jszip-produced blobs)
// expose `Blob.text()`; jsdom's `Blob` does not, so we fall back to `FileReader`.
// Keeping this in one place lets the loader and the import validator share a
// single robust path.

export function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") {
    return blob.text()
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("readError"))
    reader.readAsText(blob)
  })
}
