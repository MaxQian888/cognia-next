/**
 * @jest-environment jsdom
 */
import {
  canFetchLinkPreviews,
  checkLinkPreviewTarget,
  deadlineSignal,
  fetchLinkPreview,
  fetchPreviewImageAsDataUrl,
  LINK_PREVIEW_MAX_HTML_BYTES,
  LINK_PREVIEW_MAX_IMAGE_BYTES,
  LinkPreviewHttpError,
  LinkPreviewRefusedError,
} from "./fetch-preview"

function htmlResponse(html: string, init: ResponseInit = {}) {
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  })
}

/**
 * The jsdom project's minimal `Response` polyfill has no byte readers, and
 * DOMParser / FileReader need jsdom, so binary bodies use this stand-in. It
 * implements exactly the surface the module reads.
 */
function bytesResponse(bytes: Uint8Array, contentType: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "",
    headers: new Headers({ "content-type": contentType }),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => new TextDecoder().decode(bytes),
  } as unknown as Response
}

describe("canFetchLinkPreviews", () => {
  it("is false only in the browser build", () => {
    expect(canFetchLinkPreviews("browser")).toBe(false)
    expect(canFetchLinkPreviews("tauri")).toBe(true)
    expect(canFetchLinkPreviews("capacitor")).toBe(true)
  })
})

describe("checkLinkPreviewTarget", () => {
  it("normalizes a web URL", () => {
    expect(checkLinkPreviewTarget("https://github.com/a/b")).toBe("https://github.com/a/b")
  })

  it.each([
    ["mailto:a@b.c", "invalid-url"],
    ["not a url", "invalid-url"],
    ["http://127.0.0.1:3000/", "blocked-host"],
    ["http://169.254.169.254/latest/meta-data", "blocked-host"],
    ["http://192.168.1.10/admin", "blocked-host"],
    ["https://example.com/?email=alice@example.com", "pii"],
  ])("refuses %s (%s)", (url, reason) => {
    expect(() => checkLinkPreviewTarget(url)).toThrow(LinkPreviewRefusedError)
    try {
      checkLinkPreviewTarget(url)
    } catch (error) {
      expect((error as LinkPreviewRefusedError).reason).toBe(reason)
    }
  })
})

describe("fetchLinkPreview", () => {
  it("refuses in the browser build without touching the network", async () => {
    const fetchImpl = jest.fn()
    await expect(
      fetchLinkPreview("https://github.com/", {}, { kind: "browser", fetchImpl })
    ).rejects.toMatchObject({ reason: "unsupported-shell" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("refuses guarded targets before fetching", async () => {
    const fetchImpl = jest.fn()
    await expect(
      fetchLinkPreview("http://localhost:8080/", {}, { kind: "tauri", fetchImpl })
    ).rejects.toMatchObject({ reason: "blocked-host" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("parses a page head through the platform transport with private hosts blocked", async () => {
    const fetchImpl = jest.fn(async () =>
      htmlResponse(
        `<html><head><title>Repo</title><meta property="og:site_name" content="GitHub"></head></html>`
      )
    )
    const preview = await fetchLinkPreview(
      "https://www.github.com/deepseek-ai/dsh-libreoffice-kit",
      {},
      { kind: "tauri", fetchImpl }
    )
    expect(preview).toMatchObject({
      url: "https://www.github.com/deepseek-ai/dsh-libreoffice-kit",
      finalUrl: "https://www.github.com/deepseek-ai/dsh-libreoffice-kit",
      host: "github.com",
      kind: "page",
      contentType: "text/html",
      title: "Repo",
      siteName: "GitHub",
      faviconUrl: "https://www.github.com/favicon.ico",
    })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(init).toMatchObject({ method: "GET", blockPrivateHosts: true, redirect: "follow" })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("resolves relative metadata against the post-redirect URL when the transport reports it", async () => {
    const response = htmlResponse(`<head><meta property="og:image" content="/card.png"></head>`)
    Object.defineProperty(response, "url", { value: "https://docs.example.com/v2/page" })
    const preview = await fetchLinkPreview(
      "https://example.com/old",
      {},
      { kind: "capacitor", fetchImpl: async () => response }
    )
    expect(preview.finalUrl).toBe("https://docs.example.com/v2/page")
    expect(preview.host).toBe("docs.example.com")
    expect(preview.imageUrl).toBe("https://docs.example.com/card.png")
  })

  it("describes images and other files without parsing them", async () => {
    const image = await fetchLinkPreview(
      "https://cdn.example.com/a.png",
      {},
      {
        kind: "tauri",
        fetchImpl: async () => new Response("x", { headers: { "content-type": "image/png" } }),
      }
    )
    expect(image).toMatchObject({ kind: "image", imageUrl: "https://cdn.example.com/a.png" })

    const pdf = await fetchLinkPreview(
      "https://example.com/paper.pdf",
      {},
      {
        kind: "tauri",
        fetchImpl: async () =>
          new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
      }
    )
    expect(pdf).toMatchObject({ kind: "file", contentType: "application/pdf" })
    expect(pdf.title).toBeUndefined()
  })

  it("parses at most the HTML byte budget", async () => {
    const head = `<head><title>Big</title></head>`
    const html = head + "x".repeat(LINK_PREVIEW_MAX_HTML_BYTES * 2)
    const preview = await fetchLinkPreview(
      "https://example.com/",
      {},
      { kind: "tauri", fetchImpl: async () => htmlResponse(html) }
    )
    expect(preview.title).toBe("Big")
  })

  it("reports HTTP failures", async () => {
    await expect(
      fetchLinkPreview(
        "https://example.com/missing",
        {},
        { kind: "tauri", fetchImpl: async () => new Response("", { status: 404 }) }
      )
    ).rejects.toEqual(new LinkPreviewHttpError(404))
  })

  it("passes the caller's abort through to the transport", async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const fetchImpl = jest.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal ?? undefined
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        })
    )
    const pending = fetchLinkPreview(
      "https://example.com/",
      { signal: controller.signal },
      { kind: "tauri", fetchImpl }
    )
    controller.abort()
    await expect(pending).rejects.toThrow("aborted")
    expect(seen?.aborted).toBe(true)
  })
})

describe("fetchPreviewImageAsDataUrl", () => {
  it("returns inline data URLs untouched", async () => {
    const fetchImpl = jest.fn()
    await expect(
      fetchPreviewImageAsDataUrl("data:image/png;base64,AAAA", {}, { kind: "tauri", fetchImpl })
    ).resolves.toBe("data:image/png;base64,AAAA")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("reads an image as a data URL with binary transport and private hosts blocked", async () => {
    const fetchImpl = jest.fn(async () =>
      bytesResponse(new Uint8Array([137, 80, 78, 71]), "image/png")
    )
    const result = await fetchPreviewImageAsDataUrl(
      "https://cdn.example.com/card.png",
      {},
      { kind: "tauri", fetchImpl }
    )
    expect(result).toMatch(/^data:image\/png;base64,/)
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(init).toMatchObject({ binaryResponse: true, blockPrivateHosts: true })
  })

  it("accepts an octet-stream /favicon.ico and labels it as an icon", async () => {
    const result = await fetchPreviewImageAsDataUrl(
      "https://example.com/favicon.ico",
      {},
      {
        kind: "tauri",
        fetchImpl: async () =>
          bytesResponse(new Uint8Array([0, 0, 1, 0]), "application/octet-stream"),
      }
    )
    expect(result).toMatch(/^data:image\/x-icon;base64,/)
  })

  it("rejects non-images and oversized images", async () => {
    await expect(
      fetchPreviewImageAsDataUrl(
        "https://example.com/page",
        {},
        {
          kind: "tauri",
          fetchImpl: async () =>
            new Response("<html>", { headers: { "content-type": "text/html" } }),
        }
      )
    ).rejects.toEqual(new LinkPreviewHttpError(415))
    await expect(
      fetchPreviewImageAsDataUrl(
        "https://example.com/huge.png",
        {},
        {
          kind: "tauri",
          fetchImpl: async () =>
            bytesResponse(new Uint8Array(LINK_PREVIEW_MAX_IMAGE_BYTES + 1), "image/png"),
        }
      )
    ).rejects.toEqual(new LinkPreviewHttpError(413))
  })

  it("refuses in the browser build", async () => {
    await expect(
      fetchPreviewImageAsDataUrl("https://example.com/a.png", {}, { kind: "browser" })
    ).rejects.toMatchObject({ reason: "unsupported-shell" })
  })
})

describe("deadlineSignal", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("aborts on timeout and on the parent's abort, and disposes cleanly", () => {
    const timed = deadlineSignal(undefined, 1000)
    jest.advanceTimersByTime(999)
    expect(timed.signal.aborted).toBe(false)
    jest.advanceTimersByTime(1)
    expect(timed.signal.aborted).toBe(true)

    const parent = new AbortController()
    const linked = deadlineSignal(parent.signal, 1000)
    parent.abort("stop")
    expect(linked.signal.aborted).toBe(true)
    expect(linked.signal.reason).toBe("stop")

    const disposed = deadlineSignal(undefined, 1000)
    disposed.dispose()
    jest.advanceTimersByTime(5000)
    expect(disposed.signal.aborted).toBe(false)
  })

  it("starts aborted when the parent already is", () => {
    const parent = new AbortController()
    parent.abort()
    expect(deadlineSignal(parent.signal, 1000).signal.aborted).toBe(true)
  })
})
