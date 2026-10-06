/**
 * @jest-environment jsdom
 */
import {
  __resetLinkPreviewStoreForTesting,
  LINK_PREVIEW_ERROR_TTL_MS,
  LINK_PREVIEW_TTL_MS,
  loadLinkPreview,
  loadPreviewImage,
  markPreviewImageFailed,
  peekLinkPreview,
  peekPreviewImage,
  previewImageFailed,
  previewImagesNeedInlining,
  subscribeLinkPreview,
} from "./preview-store"

const html = (title: string) =>
  new Response(`<head><title>${title}</title></head>`, {
    headers: { "content-type": "text/html" },
  })

function imageResponse() {
  const bytes = new Uint8Array([137, 80, 78, 71])
  return {
    ok: true,
    status: 200,
    url: "",
    headers: new Headers({ "content-type": "image/png" }),
    arrayBuffer: async () => bytes.buffer.slice(0),
    text: async () => "",
  } as unknown as Response
}

afterEach(() => {
  jest.useRealTimers()
  __resetLinkPreviewStoreForTesting()
})

describe("loadLinkPreview", () => {
  it("fetches once, caches the success and notifies subscribers", async () => {
    const fetchImpl = jest.fn(async () => html("Repo"))
    __resetLinkPreviewStoreForTesting({ kind: "tauri", fetchImpl })
    const listener = jest.fn()
    subscribeLinkPreview("https://github.com/a/b", listener)

    const [a, b] = await Promise.all([
      loadLinkPreview("https://github.com/a/b"),
      loadLinkPreview("https://github.com/a/b"),
    ])
    expect(a?.title).toBe("Repo")
    expect(b).toBe(a)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(peekLinkPreview("https://github.com/a/b")).toMatchObject({ status: "ready" })

    await loadLinkPreview("https://github.com/a/b")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("caches failures for the shorter TTL and resolves to null", async () => {
    const fetchImpl = jest.fn(async () => new Response("", { status: 500 }))
    __resetLinkPreviewStoreForTesting({ kind: "tauri", fetchImpl })
    await expect(loadLinkPreview("https://example.com/")).resolves.toBeNull()
    expect(peekLinkPreview("https://example.com/")).toMatchObject({ status: "error" })
    await loadLinkPreview("https://example.com/")
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const entry = peekLinkPreview("https://example.com/")!
    expect(peekLinkPreview("https://example.com/", entry.expiresAt)).toBeUndefined()
  })

  it("expires successes after the success TTL", async () => {
    __resetLinkPreviewStoreForTesting({ kind: "tauri", fetchImpl: async () => html("x") })
    const before = Date.now()
    await loadLinkPreview("https://example.com/")
    const entry = peekLinkPreview("https://example.com/")!
    expect(entry.expiresAt - before).toBeGreaterThanOrEqual(LINK_PREVIEW_TTL_MS - 5)
    expect(entry.expiresAt - before).toBeLessThan(LINK_PREVIEW_TTL_MS + 1000)
    expect(LINK_PREVIEW_ERROR_TTL_MS).toBeLessThan(LINK_PREVIEW_TTL_MS)
  })

  it("never reaches the network in the browser build", async () => {
    const fetchImpl = jest.fn()
    __resetLinkPreviewStoreForTesting({ kind: "browser", fetchImpl })
    await expect(loadLinkPreview("https://example.com/")).resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("stops notifying after unsubscribe", async () => {
    __resetLinkPreviewStoreForTesting({ kind: "tauri", fetchImpl: async () => html("x") })
    const listener = jest.fn()
    const unsubscribe = subscribeLinkPreview("https://example.com/", listener)
    unsubscribe()
    await loadLinkPreview("https://example.com/")
    expect(listener).not.toHaveBeenCalled()
  })
})

describe("preview images", () => {
  it("passes remote URLs straight through where remote images load", async () => {
    __resetLinkPreviewStoreForTesting({ kind: "capacitor", fetchImpl: jest.fn() })
    expect(previewImagesNeedInlining()).toBe(false)
    expect(peekPreviewImage("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png")
    await expect(loadPreviewImage("https://cdn.example.com/a.png")).resolves.toBe(
      "https://cdn.example.com/a.png"
    )
  })

  it("inlines images as data URLs on the desktop, once", async () => {
    const fetchImpl = jest.fn(async () => imageResponse())
    __resetLinkPreviewStoreForTesting({ kind: "tauri", fetchImpl })
    expect(previewImagesNeedInlining()).toBe(true)
    expect(peekPreviewImage("https://cdn.example.com/a.png")).toBeNull()
    const [first, second] = await Promise.all([
      loadPreviewImage("https://cdn.example.com/a.png"),
      loadPreviewImage("https://cdn.example.com/a.png"),
    ])
    expect(first).toMatch(/^data:image\/png;base64,/)
    expect(second).toBe(first)
    expect(peekPreviewImage("https://cdn.example.com/a.png")).toBe(first)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("remembers failures, including ones reported by a remote <img>", async () => {
    const fetchImpl = jest.fn(async () => new Response("", { status: 404 }))
    __resetLinkPreviewStoreForTesting({ kind: "tauri", fetchImpl })
    await expect(loadPreviewImage("https://cdn.example.com/missing.png")).resolves.toBeNull()
    expect(previewImageFailed("https://cdn.example.com/missing.png")).toBe(true)
    await loadPreviewImage("https://cdn.example.com/missing.png")
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    __resetLinkPreviewStoreForTesting({ kind: "capacitor" })
    const listener = jest.fn()
    subscribeLinkPreview("https://cdn.example.com/b.png", listener)
    markPreviewImageFailed("https://cdn.example.com/b.png")
    expect(previewImageFailed("https://cdn.example.com/b.png")).toBe(true)
    expect(listener).toHaveBeenCalled()
  })

  it("returns inline data favicons as they are", () => {
    __resetLinkPreviewStoreForTesting({ kind: "tauri" })
    expect(peekPreviewImage("data:image/png;base64,AA")).toBe("data:image/png;base64,AA")
  })
})
