/** @jest-environment jsdom */
// Coverage for the dual-backend (Tauri disk / IndexedDB) wallpaper storage
// abstraction. We mock `@tauri-apps/api/core` and the Tauri detector so a
// single jsdom test can exercise both branches without spinning up the real
// Tauri runtime.

import "fake-indexeddb/auto"

jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tauriCore = require("@tauri-apps/api/core") as { invoke: jest.Mock }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tauri = require("@/lib/tauri") as { isTauri: jest.Mock }

import {
  MAX_WALLPAPER_BYTES,
  arrayBufferToBase64,
  deleteImage,
  disposeUrl,
  makeWallpaper,
  mimeToExtension,
  resolveSourceToCss,
  saveImage,
} from "./wallpaper-storage"

const realCreateObjectURL = globalThis.URL.createObjectURL
const realRevokeObjectURL = globalThis.URL.revokeObjectURL
let revokedUrls: string[] = []
let issuedCounter = 0

beforeEach(() => {
  jest.clearAllMocks()
  revokedUrls = []
  issuedCounter = 0
  globalThis.URL.createObjectURL = jest.fn(() => `blob:mock-${++issuedCounter}`)
  globalThis.URL.revokeObjectURL = jest.fn((url: string) => {
    revokedUrls.push(url)
  })
})

afterAll(() => {
  globalThis.URL.createObjectURL = realCreateObjectURL
  globalThis.URL.revokeObjectURL = realRevokeObjectURL
})

describe("mimeToExtension", () => {
  it("maps known mimes", () => {
    expect(mimeToExtension("image/png")).toBe("png")
    expect(mimeToExtension("image/jpeg")).toBe("jpg")
    expect(mimeToExtension("image/jpg")).toBe("jpg")
    expect(mimeToExtension("image/webp")).toBe("webp")
    expect(mimeToExtension("image/gif")).toBe("gif")
    expect(mimeToExtension("image/avif")).toBe("avif")
    expect(mimeToExtension("image/svg+xml")).toBe("svg")
  })
  it("falls back to bin for unknown mimes", () => {
    expect(mimeToExtension("application/zip")).toBe("bin")
  })
})

describe("arrayBufferToBase64", () => {
  it("encodes empty buffers", () => {
    expect(arrayBufferToBase64(new ArrayBuffer(0))).toBe("")
  })
  it("round-trips bytes through atob", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111])
    const b64 = arrayBufferToBase64(bytes.buffer)
    expect(atob(b64)).toBe("Hello")
  })
  it("handles a buffer larger than the chunk size", () => {
    // 100K is well over the 32K chunking boundary inside the helper.
    const view = new Uint8Array(100_000)
    for (let i = 0; i < view.length; i += 1) view[i] = i % 256
    const b64 = arrayBufferToBase64(view.buffer)
    const decoded = atob(b64)
    expect(decoded.length).toBe(view.length)
    expect(decoded.charCodeAt(0)).toBe(0)
    expect(decoded.charCodeAt(255)).toBe(255)
  })
})

describe("saveImage (Tauri / disk path)", () => {
  beforeEach(() => {
    tauri.isTauri.mockReturnValue(true)
  })

  it("invokes wallpaper_save with a base64 payload and returns a disk source", async () => {
    tauriCore.invoke.mockResolvedValue({
      rel_path: "abc.png",
      abs_path: "/x/y/abc.png",
      bytes: 5,
    })
    const result = await saveImage({
      id: "abc",
      mime: "image/png",
      bytes: new Uint8Array([1, 2, 3, 4, 5]).buffer,
      width: 800,
      height: 600,
    })
    expect(tauriCore.invoke).toHaveBeenCalledWith("wallpaper_save", {
      fileName: "abc.png",
      base64Data: expect.any(String),
    })
    expect(result.source).toEqual({
      kind: "image",
      storage: "disk",
      relPath: "abc.png",
      mime: "image/png",
      width: 800,
      height: 600,
    })
    expect(result.previewUrl.startsWith("data:image/png;base64,")).toBe(true)
  })

  it("rejects payloads larger than the cap", async () => {
    const huge = new Uint8Array(MAX_WALLPAPER_BYTES + 1)
    await expect(
      saveImage({ id: "x", mime: "image/png", bytes: huge.buffer, width: 1, height: 1 })
    ).rejects.toThrow(/exceeds/)
  })
})

describe("saveImage (web / IndexedDB path)", () => {
  beforeEach(() => {
    tauri.isTauri.mockReturnValue(false)
  })

  it("stores a Blob keyed by id and returns an Object URL preview", async () => {
    const result = await saveImage({
      id: "wp-web",
      mime: "image/png",
      bytes: new Uint8Array([9, 8, 7]).buffer,
      width: 10,
      height: 20,
    })
    expect(result.source).toEqual({
      kind: "image",
      storage: "indexeddb",
      blobKey: "wp-web",
      mime: "image/png",
      width: 10,
      height: 20,
    })
    expect(result.previewUrl.startsWith("blob:mock-")).toBe(true)
  })
})

describe("resolveSourceToCss", () => {
  it("returns gradient css verbatim", async () => {
    expect(
      await resolveSourceToCss({ kind: "gradient", css: "linear-gradient(0deg, red, blue)" })
    ).toBe("linear-gradient(0deg, red, blue)")
  })

  it("returns color value verbatim", async () => {
    expect(await resolveSourceToCss({ kind: "color", value: "#abcdef" })).toBe("#abcdef")
  })

  it("wraps inline data URLs in url(...)", async () => {
    const css = await resolveSourceToCss({
      kind: "image",
      storage: "data-url",
      dataUrl: "data:image/png;base64,AA",
      mime: "image/png",
      width: 1,
      height: 1,
    })
    expect(css).toBe("url('data:image/png;base64,AA')")
  })

  it("invokes wallpaper_read_data_url for disk-stored wallpapers", async () => {
    tauri.isTauri.mockReturnValue(true)
    tauriCore.invoke.mockResolvedValue({
      data_url: "data:image/png;base64,XX",
      mime: "image/png",
      bytes: 2,
    })
    const css = await resolveSourceToCss({
      kind: "image",
      storage: "disk",
      relPath: "abc.png",
      mime: "image/png",
      width: 1,
      height: 1,
    })
    expect(tauriCore.invoke).toHaveBeenCalledWith("wallpaper_read_data_url", {
      fileName: "abc.png",
    })
    expect(css).toBe("url('data:image/png;base64,XX')")
  })

  it("loads the blob and produces an Object URL for indexeddb-stored wallpapers", async () => {
    tauri.isTauri.mockReturnValue(false)
    // Seed the IDB store via saveImage first.
    await saveImage({
      id: "wp-resolve",
      mime: "image/png",
      bytes: new Uint8Array([1]).buffer,
      width: 1,
      height: 1,
    })
    const css = await resolveSourceToCss({
      kind: "image",
      storage: "indexeddb",
      blobKey: "wp-resolve",
      mime: "image/png",
      width: 1,
      height: 1,
    })
    expect(css).toMatch(/^url\('blob:mock-\d+'\)$/)
  })

  it("throws when the indexeddb blob is missing", async () => {
    tauri.isTauri.mockReturnValue(false)
    await expect(
      resolveSourceToCss({
        kind: "image",
        storage: "indexeddb",
        blobKey: "does-not-exist",
        mime: "image/png",
        width: 1,
        height: 1,
      })
    ).rejects.toThrow(/missing/)
  })
})

describe("disposeUrl", () => {
  it("revokes blob: urls", () => {
    disposeUrl("url('blob:foo')")
    expect(revokedUrls).toEqual(["blob:foo"])
  })
  it("ignores non-blob urls", () => {
    disposeUrl("linear-gradient(red, blue)")
    disposeUrl("url('data:image/png;base64,...')")
    expect(revokedUrls).toEqual([])
  })
})

describe("deleteImage", () => {
  it("is a no-op for gradients and colors", async () => {
    tauri.isTauri.mockReturnValue(true)
    await deleteImage({ kind: "gradient", css: "linear-gradient(0,red,blue)" })
    await deleteImage({ kind: "color", value: "#000" })
    expect(tauriCore.invoke).not.toHaveBeenCalled()
  })

  it("invokes wallpaper_delete for disk sources in Tauri", async () => {
    tauri.isTauri.mockReturnValue(true)
    tauriCore.invoke.mockResolvedValue(undefined)
    await deleteImage({
      kind: "image",
      storage: "disk",
      relPath: "abc.png",
      mime: "image/png",
      width: 1,
      height: 1,
    })
    expect(tauriCore.invoke).toHaveBeenCalledWith("wallpaper_delete", { fileName: "abc.png" })
  })

  it("swallows wallpaper_delete failures", async () => {
    tauri.isTauri.mockReturnValue(true)
    tauriCore.invoke.mockRejectedValueOnce(new Error("boom"))
    await expect(
      deleteImage({
        kind: "image",
        storage: "disk",
        relPath: "abc.png",
        mime: "image/png",
        width: 1,
        height: 1,
      })
    ).resolves.toBeUndefined()
  })

  it("does not call disk delete in web mode", async () => {
    tauri.isTauri.mockReturnValue(false)
    await deleteImage({
      kind: "image",
      storage: "disk",
      relPath: "x.png",
      mime: "image/png",
      width: 1,
      height: 1,
    })
    expect(tauriCore.invoke).not.toHaveBeenCalled()
  })

  it("removes indexeddb entries", async () => {
    tauri.isTauri.mockReturnValue(false)
    await saveImage({
      id: "wp-del",
      mime: "image/png",
      bytes: new Uint8Array([1]).buffer,
      width: 1,
      height: 1,
    })
    await deleteImage({
      kind: "image",
      storage: "indexeddb",
      blobKey: "wp-del",
      mime: "image/png",
      width: 1,
      height: 1,
    })
    await expect(
      resolveSourceToCss({
        kind: "image",
        storage: "indexeddb",
        blobKey: "wp-del",
        mime: "image/png",
        width: 1,
        height: 1,
      })
    ).rejects.toThrow(/missing/)
  })
})

describe("makeWallpaper", () => {
  it("constructs a wallpaper row from id + name + source", () => {
    const wp = makeWallpaper({
      id: "x",
      name: "X",
      source: { kind: "color", value: "#fff" },
    })
    expect(wp).toMatchObject({
      id: "x",
      name: "X",
      kind: "color",
      builtin: false,
      source: { kind: "color", value: "#fff" },
    })
    expect(typeof wp.createdAt).toBe("number")
  })

  it("respects explicit builtin + createdAt", () => {
    const wp = makeWallpaper({
      id: "y",
      name: "Y",
      source: { kind: "color", value: "#000" },
      builtin: true,
      createdAt: 42,
    })
    expect(wp.builtin).toBe(true)
    expect(wp.createdAt).toBe(42)
  })
})
