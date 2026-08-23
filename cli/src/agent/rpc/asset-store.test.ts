import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { AssetStoreError, createAssetStore, type AssetStore } from "./asset-store"

const bytes = Buffer.from("hello asset", "utf8")
const base64 = bytes.toString("base64")
const digest = `sha256-${createHash("sha256").update(bytes).digest("hex")}`

describe("createAssetStore", () => {
  let home: string
  let store: AssetStore

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "cognia-assets-"))
    store = createAssetStore({ home })
  })

  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it("stores bytes under their content digest", () => {
    const record = store.put({ data: base64, mediaType: "text/plain", name: "note.txt" })
    expect(record).toMatchObject({
      digest,
      mediaType: "text/plain",
      byteLength: bytes.byteLength,
      name: "note.txt",
    })
    expect(record.assetId).toMatch(/^asset-[0-9a-f]{32}$/)
    expect(readFileSync(store.resolve(record.assetId))).toEqual(bytes)
  })

  it("gives identical bytes one id and stores them once", () => {
    const first = store.put({ data: base64, mediaType: "text/plain" })
    const second = store.put({ data: base64, mediaType: "text/plain" })
    expect(second.assetId).toBe(first.assetId)
    expect(store.resolve(second.assetId)).toBe(store.resolve(first.assetId))
  })

  it("writes blobs 0600 in a 0700 directory", () => {
    const record = store.put({ data: base64, mediaType: "text/plain" })
    expect(statSync(store.resolve(record.assetId)).mode & 0o777).toBe(0o600)
    expect(statSync(path.join(home, "assets")).mode & 0o777).toBe(0o700)
  })

  it("refuses an upload past the ceiling", () => {
    const small = createAssetStore({ home, maxBytes: 4 })
    expect(() => small.put({ data: base64, mediaType: "text/plain" })).toThrow(
      expect.objectContaining({ code: "too_large" })
    )
  })

  it("requires a media type on upload", () => {
    expect(() => store.put({ data: base64, mediaType: "" })).toThrow(
      expect.objectContaining({ code: "invalid" })
    )
  })

  it("registers a host path without copying it", () => {
    const source = path.join(home, "source.png")
    writeFileSync(source, bytes)
    const record = store.registerPath({ path: source })
    expect(record).toMatchObject({
      digest,
      mediaType: "image/png",
      byteLength: bytes.byteLength,
      name: "source.png",
    })
    // Resolved to the original file, not a copy in the store.
    expect(store.resolve(record.assetId)).toBe(source)
  })

  it("infers a media type from the extension and honours an explicit one", () => {
    const source = path.join(home, "data.bin")
    writeFileSync(source, bytes)
    expect(store.registerPath({ path: source }).mediaType).toBe("application/octet-stream")
    expect(store.registerPath({ path: source, mediaType: "text/csv" }).mediaType).toBe("text/csv")
  })

  it("detects a registered file changing underneath it", () => {
    const source = path.join(home, "mutable.txt")
    writeFileSync(source, bytes)
    const record = store.registerPath({ path: source })
    writeFileSync(source, "something else")
    expect(() => store.resolve(record.assetId)).toThrow(
      expect.objectContaining({ code: "unreadable" })
    )
  })

  it("refuses a path that is missing or is not a file", () => {
    expect(() => store.registerPath({ path: path.join(home, "nope") })).toThrow(
      expect.objectContaining({ code: "unreadable" })
    )
    expect(() => store.registerPath({ path: home })).toThrow(
      expect.objectContaining({ code: "invalid" })
    )
  })

  it("refuses to register a file past the ceiling", () => {
    const source = path.join(home, "big.bin")
    writeFileSync(source, bytes)
    const small = createAssetStore({ home, maxBytes: 4 })
    expect(() => small.registerPath({ path: source })).toThrow(
      expect.objectContaining({ code: "too_large" })
    )
  })

  it("reports an unknown asset rather than inventing one", () => {
    for (const call of [
      () => store.stat("asset-missing"),
      () => store.resolve("asset-missing"),
      () => store.delete("asset-missing"),
    ]) {
      expect(call).toThrow(expect.objectContaining({ code: "not_found" }))
    }
  })

  it("deletes stored bytes but never the caller's own file", () => {
    const uploaded = store.put({ data: base64, mediaType: "text/plain" })
    const blob = store.resolve(uploaded.assetId)
    store.delete(uploaded.assetId)
    expect(() => store.stat(uploaded.assetId)).toThrow(AssetStoreError)
    expect(() => readFileSync(blob)).toThrow()

    const source = path.join(home, "keep.txt")
    writeFileSync(source, bytes)
    const registered = store.registerPath({ path: source })
    store.delete(registered.assetId)
    expect(readFileSync(source)).toEqual(bytes)
  })

  it("survives a restart, because the store is the filesystem", () => {
    const record = store.put({ data: base64, mediaType: "text/plain" })
    const reopened = createAssetStore({ home })
    expect(reopened.stat(record.assetId)).toMatchObject({ digest, byteLength: bytes.byteLength })
  })
})
