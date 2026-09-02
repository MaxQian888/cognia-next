/** @jest-environment jsdom */

import {
  DAILY_WALLPAPER_ID_PREFIX,
  fetchDailyWallpaper,
  selectExpiredDailyWallpapers,
} from "./fetch-daily-wallpaper"
import {
  DEFAULT_DAILY_WALLPAPER,
  MAX_DAILY_IMAGE_BYTES,
  type DailyWallpaperSettings,
} from "@/types/appearance/daily-wallpaper"
import type { Wallpaper } from "@/types/appearance"

function settings(patch: Partial<DailyWallpaperSettings> = {}): DailyWallpaperSettings {
  return { ...DEFAULT_DAILY_WALLPAPER, enabled: true, ...patch }
}

const save = jest.fn(async (input: { id: string; mime: string }) => ({
  source: {
    kind: "image" as const,
    storage: "indexeddb" as const,
    blobKey: input.id,
    mime: input.mime,
    width: 1920,
    height: 1080,
  },
  previewUrl: "blob:preview",
}))

interface StubResponse {
  ok?: boolean
  status?: number
  json?: unknown
  body?: ArrayBuffer
  headers?: Record<string, string>
}

function respond(stub: StubResponse): Response {
  const headers = new Headers(stub.headers ?? {})
  return {
    ok: stub.ok ?? true,
    status: stub.status ?? 200,
    headers,
    json: async () => stub.json,
    arrayBuffer: async () => stub.body ?? new ArrayBuffer(64),
  } as unknown as Response
}

/** A transport that answers the JSON call then the image call, in order. */
function transport(...responses: (StubResponse | Error)[]) {
  const calls: string[] = []
  let index = 0
  const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input))
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (next instanceof Error) throw next
    return respond(next)
  })
  return { fetchImpl: fetchImpl as never, calls }
}

const BING_JSON = {
  images: [{ url: "/th?id=OHR.Test_1920x1080.jpg", startdate: "20260903", title: "Test" }],
}

const IMAGE_HEADERS = { "content-type": "image/jpeg", "content-length": "64" }

beforeEach(() => {
  save.mockClear()
})

describe("fetchDailyWallpaper", () => {
  it("fetches, validates and stores a Bing image", async () => {
    const { fetchImpl, calls } = transport({ json: BING_JSON }, { headers: IMAGE_HEADERS })
    const result = await fetchDailyWallpaper({
      settings: settings(),
      locale: "en",
      fetchImpl,
      save: save as never,
      now: () => 1000,
    })

    expect(result).toMatchObject({ ok: true })
    if (!("wallpaper" in result)) throw new Error("expected a stored wallpaper")
    expect(result.wallpaper.id.startsWith(DAILY_WALLPAPER_ID_PREFIX)).toBe(true)
    expect(result.wallpaper.name).toBe("Test")
    expect(calls[0]).toContain("HPImageArchive.aspx")
    expect(calls[1]).toContain("bing.com")
  })

  it("skips the download when today's image is already stored", async () => {
    // The difference between a daily wallpaper and a daily re-download.
    const { fetchImpl } = transport({ json: BING_JSON })
    const result = await fetchDailyWallpaper({
      settings: settings({ lastEntryKey: "20260903" }),
      locale: "en",
      fetchImpl,
      save: save as never,
    })

    expect(result).toEqual({ ok: true, skipped: "already-current", entryKey: "20260903" })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()
  })

  it("refuses a custom source pointing at loopback", async () => {
    const { fetchImpl } = transport({ json: {} })
    const result = await fetchDailyWallpaper({
      settings: settings({
        providerId: "custom",
        custom: { url: "https://127.0.0.1/api", kind: "json", imagePath: "a" },
      }),
      locale: "en",
      fetchImpl,
      save: save as never,
    })

    expect(result).toEqual({ ok: false, code: "blocked-host" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("refuses a custom source pointing at cloud metadata", async () => {
    const { fetchImpl } = transport({ json: {} })
    const result = await fetchDailyWallpaper({
      settings: settings({
        providerId: "custom",
        custom: { url: "https://169.254.169.254/latest/meta-data", kind: "image" },
      }),
      locale: "en",
      fetchImpl,
      save: save as never,
    })

    expect(result).toEqual({ ok: false, code: "blocked-host" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("refuses an IPv6 loopback however it is spelled", async () => {
    const { fetchImpl } = transport({ json: {} })
    const result = await fetchDailyWallpaper({
      settings: settings({
        providerId: "custom",
        custom: { url: "https://[::1]/api", kind: "image" },
      }),
      locale: "en",
      fetchImpl,
      save: save as never,
    })
    expect(result).toEqual({ ok: false, code: "blocked-host" })
  })

  it("refuses an image url a provider response tried to redirect off-origin", async () => {
    // The response is remote input. A Bing document naming an image on
    // attacker.test must not turn this into an arbitrary fetch primitive.
    const { fetchImpl } = transport({
      json: { images: [{ url: "https://attacker.test/pixel.jpg", startdate: "20260903" }] },
    })
    const result = await fetchDailyWallpaper({
      settings: settings(),
      locale: "en",
      fetchImpl,
      save: save as never,
    })

    expect(result).toEqual({ ok: false, code: "blocked-host" })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()
  })

  it("rejects a response that is not an image type", async () => {
    const { fetchImpl } = transport(
      { json: BING_JSON },
      { headers: { "content-type": "text/html" } }
    )
    const result = await fetchDailyWallpaper({
      settings: settings(),
      locale: "en",
      fetchImpl,
      save: save as never,
    })
    expect(result).toEqual({ ok: false, code: "not-an-image" })
    expect(save).not.toHaveBeenCalled()
  })

  it("rejects an oversized image from its declared length, before reading the body", async () => {
    const arrayBuffer = jest.fn()
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("HPImageArchive")) return respond({ json: BING_JSON })
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          "content-type": "image/jpeg",
          "content-length": String(MAX_DAILY_IMAGE_BYTES + 1),
        }),
        arrayBuffer,
      } as unknown as Response
    })

    const result = await fetchDailyWallpaper({
      settings: settings(),
      locale: "en",
      fetchImpl: fetchImpl as never,
      save: save as never,
    })
    expect(result).toEqual({ ok: false, code: "too-large" })
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it("rejects an oversized body that lied about its length", async () => {
    const { fetchImpl } = transport(
      { json: BING_JSON },
      {
        headers: { "content-type": "image/jpeg" },
        body: new ArrayBuffer(MAX_DAILY_IMAGE_BYTES + 1),
      }
    )
    const result = await fetchDailyWallpaper({
      settings: settings(),
      locale: "en",
      fetchImpl,
      save: save as never,
    })
    expect(result).toEqual({ ok: false, code: "too-large" })
  })

  it("rejects an empty body", async () => {
    const { fetchImpl } = transport(
      { json: BING_JSON },
      { headers: { "content-type": "image/jpeg" }, body: new ArrayBuffer(0) }
    )
    const result = await fetchDailyWallpaper({
      settings: settings(),
      locale: "en",
      fetchImpl,
      save: save as never,
    })
    expect(result).toEqual({ ok: false, code: "not-an-image" })
  })

  it("distinguishes a rate limit from a broken endpoint", async () => {
    // NASA's DEMO_KEY exhaustion is the common case, and "wait" is very
    // different advice from "this is misconfigured".
    for (const status of [429, 403]) {
      const { fetchImpl } = transport({ ok: false, status })
      const result = await fetchDailyWallpaper({
        settings: settings({ providerId: "nasaApod" }),
        locale: "en",
        fetchImpl,
        save: save as never,
      })
      expect(result).toEqual({ ok: false, code: "rate-limited", status })
    }
  })

  it("reports an ordinary bad status as a bad response", async () => {
    const { fetchImpl } = transport({ ok: false, status: 500 })
    const result = await fetchDailyWallpaper({
      settings: settings(),
      locale: "en",
      fetchImpl,
      save: save as never,
    })
    expect(result).toEqual({ ok: false, code: "bad-response", status: 500 })
  })

  it("reports a transport failure as a network error", async () => {
    const { fetchImpl } = transport(new Error("offline"))
    const result = await fetchDailyWallpaper({
      settings: settings(),
      locale: "en",
      fetchImpl,
      save: save as never,
    })
    expect(result).toEqual({ ok: false, code: "network" })
  })

  it("reports a storage failure distinctly from a network one", async () => {
    const { fetchImpl } = transport({ json: BING_JSON }, { headers: IMAGE_HEADERS })
    const result = await fetchDailyWallpaper({
      settings: settings(),
      locale: "en",
      fetchImpl,
      save: (async () => {
        throw new Error("disk full")
      }) as never,
    })
    expect(result).toEqual({ ok: false, code: "storage-failed" })
  })

  it("reports a day with no image as unsupported media", async () => {
    const { fetchImpl } = transport({
      json: { media_type: "video", date: "2026-09-03", url: "https://youtube.test/x" },
    })
    const result = await fetchDailyWallpaper({
      settings: settings({ providerId: "nasaApod" }),
      locale: "en",
      fetchImpl,
      save: save as never,
    })
    expect(result).toEqual({ ok: false, code: "unsupported-media" })
  })

  it("refuses an empty custom url without contacting anything", async () => {
    const { fetchImpl } = transport({ json: {} })
    const result = await fetchDailyWallpaper({
      settings: settings({ providerId: "custom" }),
      locale: "en",
      fetchImpl,
      save: save as never,
    })
    expect(result).toEqual({ ok: false, code: "bad-response" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("selectExpiredDailyWallpapers", () => {
  const daily = (id: string, createdAt: number): Wallpaper => ({
    id: `${DAILY_WALLPAPER_ID_PREFIX}${id}`,
    name: id,
    kind: "image",
    source: {
      kind: "image",
      storage: "indexeddb",
      blobKey: id,
      mime: "image/jpeg",
      width: 1,
      height: 1,
    },
    builtin: false,
    createdAt,
  })

  const userUpload: Wallpaper = { ...daily("mine", 0), id: "wp_mine" }

  it("keeps the newest N and returns the rest", () => {
    const gallery = [daily("a", 3), daily("b", 2), daily("c", 1)]
    expect(selectExpiredDailyWallpapers(gallery, 2, null).map((w) => w.id)).toEqual([
      `${DAILY_WALLPAPER_ID_PREFIX}c`,
    ])
  })

  it("returns nothing while under the limit", () => {
    expect(selectExpiredDailyWallpapers([daily("a", 1)], 7, null)).toEqual([])
  })

  it("never reaps a wallpaper the user uploaded themselves", () => {
    // Retention is a setting about the daily SOURCE. It must not delete
    // something the user put there by hand.
    const gallery = [userUpload, daily("a", 3), daily("b", 2)]
    const expired = selectExpiredDailyWallpapers(gallery, 1, null)
    expect(expired.map((w) => w.id)).toEqual([`${DAILY_WALLPAPER_ID_PREFIX}b`])
  })

  it("never reaps the wallpaper currently on screen", () => {
    // Blanking the background as a side effect of a cleanup nobody asked for.
    const gallery = [daily("a", 3), daily("b", 2), daily("c", 1)]
    const expired = selectExpiredDailyWallpapers(gallery, 1, `${DAILY_WALLPAPER_ID_PREFIX}c`)
    expect(expired.map((w) => w.id)).toEqual([`${DAILY_WALLPAPER_ID_PREFIX}b`])
  })

  it("ignores built-ins even if their id somehow matches", () => {
    const builtin = { ...daily("preset", 1), builtin: true }
    expect(selectExpiredDailyWallpapers([builtin], 0, null)).toEqual([])
  })

  it("treats a keepCount of zero as reaping everything eligible", () => {
    const gallery = [daily("a", 2), daily("b", 1)]
    expect(selectExpiredDailyWallpapers(gallery, 0, null)).toHaveLength(2)
  })
})
