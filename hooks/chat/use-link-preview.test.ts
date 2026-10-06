/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"
import { __resetLinkPreviewStoreForTesting } from "@/lib/web/link-preview/preview-store"
import { useLinkPreview, usePreviewImage } from "./use-link-preview"

const mockKind = { current: "tauri" as "tauri" | "capacitor" | "browser" }
jest.mock("@/lib/network/platform-fetch", () => ({
  ...jest.requireActual("@/lib/network/platform-fetch"),
  platformFetchKind: () => mockKind.current,
}))

const htmlResponse = (title: string) =>
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
  mockKind.current = "tauri"
  __resetLinkPreviewStoreForTesting()
})

describe("useLinkPreview", () => {
  it("loads while enabled and settles to ready", async () => {
    const fetchImpl = jest.fn(async () => htmlResponse("Repo"))
    __resetLinkPreviewStoreForTesting({ kind: "tauri", fetchImpl })
    const { result } = renderHook(() => useLinkPreview("https://github.com/a/b", true))
    expect(result.current).toEqual({ status: "loading" })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current).toMatchObject({ preview: { title: "Repo" } })
  })

  it("stays local and silent when disabled, without a URL, or in the browser", () => {
    const fetchImpl = jest.fn()
    __resetLinkPreviewStoreForTesting({ kind: "tauri", fetchImpl })
    expect(renderHook(() => useLinkPreview("https://a.test/", false)).result.current).toEqual({
      status: "local",
    })
    expect(renderHook(() => useLinkPreview(null, true)).result.current).toEqual({
      status: "local",
    })
    mockKind.current = "browser"
    expect(renderHook(() => useLinkPreview("https://a.test/", true)).result.current).toEqual({
      status: "local",
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("reports errors", async () => {
    __resetLinkPreviewStoreForTesting({
      kind: "tauri",
      fetchImpl: async () => new Response("", { status: 404 }),
    })
    const { result } = renderHook(() => useLinkPreview("https://example.com/gone", true))
    await waitFor(() => expect(result.current).toEqual({ status: "error" }))
  })

  it("starts fetching when it becomes enabled", async () => {
    const fetchImpl = jest.fn(async () => htmlResponse("Later"))
    __resetLinkPreviewStoreForTesting({ kind: "tauri", fetchImpl })
    const { result, rerender } = renderHook(
      ({ enabled }) => useLinkPreview("https://example.com/", enabled),
      { initialProps: { enabled: false } }
    )
    expect(fetchImpl).not.toHaveBeenCalled()
    rerender({ enabled: true })
    await waitFor(() => expect(result.current.status).toBe("ready"))
  })
})

describe("usePreviewImage", () => {
  it("inlines on the desktop", async () => {
    const fetchImpl = jest.fn(async () => imageResponse())
    __resetLinkPreviewStoreForTesting({ kind: "tauri", fetchImpl })
    const { result } = renderHook(() => usePreviewImage("https://cdn.example.com/a.png"))
    expect(result.current.src).toBeNull()
    await waitFor(() => expect(result.current.src).toMatch(/^data:image\/png;base64,/))
  })

  it("passes remote URLs through elsewhere and forgets them after an <img> error", () => {
    mockKind.current = "capacitor"
    __resetLinkPreviewStoreForTesting({ kind: "capacitor" })
    const { result } = renderHook(() => usePreviewImage("https://cdn.example.com/a.png"))
    expect(result.current.src).toBe("https://cdn.example.com/a.png")
    act(() => result.current.onError())
    expect(result.current.src).toBeNull()
  })

  it("does nothing without a URL or when disabled", () => {
    __resetLinkPreviewStoreForTesting({ kind: "capacitor" })
    expect(renderHook(() => usePreviewImage(undefined)).result.current.src).toBeNull()
    expect(
      renderHook(() => usePreviewImage("https://a.test/x.png", false)).result.current.src
    ).toBe(null)
  })
})
