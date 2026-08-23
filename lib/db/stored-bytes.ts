/**
 * Read binary back out of IndexedDB as a `Uint8Array`, whatever shape the
 * engine chose to rehydrate it as.
 *
 * A typed array does not reliably survive a structured clone as the same thing
 * it went in as. WebKit — which is what both the Tauri and Capacitor shells run
 * — has a long history here (see the note on `DraftAttachmentMeta.bytes`), and
 * the fake IndexedDB the tests run on hands a `Uint8Array` back as a plain
 * index-keyed object. Anything that appends to, hashes, or uploads stored bytes
 * would otherwise depend on which engine happened to be underneath.
 *
 * A leaf with no imports on purpose: both the draft store and the attachment
 * upload store need it, and neither should have to import the other to get it.
 */
export function readStoredBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (Array.isArray(value)) return Uint8Array.from(value)
  // An index-keyed object: `{0: 137, 1: 80, …}`. Reconstructed by position
  // rather than by `Object.values`, which is only insertion-ordered for
  // non-numeric keys and would silently reorder the file otherwise.
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length === 0 || !keys.every((key) => /^\d+$/.test(key))) return undefined
    const bytes = new Uint8Array(keys.length)
    for (let index = 0; index < keys.length; index++) {
      const byte = record[String(index)]
      if (typeof byte !== "number") return undefined
      bytes[index] = byte
    }
    return bytes
  }
  return undefined
}
