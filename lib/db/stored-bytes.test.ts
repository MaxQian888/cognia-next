import { readStoredBytes } from "./stored-bytes"

describe("readStoredBytes", () => {
  it("passes a typed array straight through", () => {
    const bytes = Uint8Array.from([1, 2, 3])
    expect(readStoredBytes(bytes)).toBe(bytes)
  })

  it("rebuilds from the shapes a structured clone can hand back", () => {
    expect(readStoredBytes(Uint8Array.from([9, 8]).buffer)).toEqual(Uint8Array.from([9, 8]))
    expect(readStoredBytes([4, 5, 6])).toEqual(Uint8Array.from([4, 5, 6]))
    // What fake-indexeddb — and, historically, WebKit — return.
    expect(readStoredBytes({ 0: 137, 1: 80, 2: 78 })).toEqual(Uint8Array.from([137, 80, 78]))
  })

  it("keeps a view's own window rather than its whole backing buffer", () => {
    const view = Uint8Array.from([1, 2, 3, 4, 5]).subarray(1, 3)
    expect(readStoredBytes(new Uint16Array(view.buffer, 0, 1))?.byteLength).toBe(2)
  })

  it("reads an index-keyed object by position, not by key order", () => {
    // `Object.values` is insertion-ordered, and an engine is free to hand the
    // keys back in any order — trusting it would silently reorder the file.
    expect(readStoredBytes({ 2: 3, 0: 1, 1: 2 })).toEqual(Uint8Array.from([1, 2, 3]))
  })

  it("returns undefined for anything that is not stored bytes", () => {
    expect(readStoredBytes(undefined)).toBeUndefined()
    expect(readStoredBytes(null)).toBeUndefined()
    expect(readStoredBytes("data:image/png;base64,AAAA")).toBeUndefined()
    expect(readStoredBytes({})).toBeUndefined()
    expect(readStoredBytes({ name: "shot.png" })).toBeUndefined()
    expect(readStoredBytes({ 0: "137" })).toBeUndefined()
  })
})
