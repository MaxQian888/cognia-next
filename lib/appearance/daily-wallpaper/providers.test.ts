import {
  bingProvider,
  customProvider,
  getDailyWallpaperProvider,
  isAllowedProviderHost,
  nasaApodProvider,
  resolveBingMarket,
  resolveCustomImageUrl,
  resolveNasaApiKey,
} from "./providers"
import {
  DEFAULT_DAILY_WALLPAPER,
  type DailyWallpaperSettings,
} from "@/types/appearance/daily-wallpaper"

function settings(patch: Partial<DailyWallpaperSettings> = {}): DailyWallpaperSettings {
  return { ...DEFAULT_DAILY_WALLPAPER, ...patch }
}

describe("resolveBingMarket", () => {
  it("maps the app locale when set to auto", () => {
    expect(resolveBingMarket({ market: "auto", resolution: "1080p" }, "zh-CN")).toBe("zh-CN")
    expect(resolveBingMarket({ market: "auto", resolution: "1080p" }, "ja")).toBe("ja-JP")
  })

  it("falls back through the language subtag", () => {
    expect(resolveBingMarket({ market: "auto", resolution: "1080p" }, "fr-CA")).toBe("fr-FR")
  })

  it("falls back to en-US for an unmapped locale", () => {
    expect(resolveBingMarket({ market: "auto", resolution: "1080p" }, "xx-YY")).toBe("en-US")
  })

  it("honours an explicit market over the locale", () => {
    expect(resolveBingMarket({ market: "de-DE", resolution: "1080p" }, "zh-CN")).toBe("de-DE")
  })
})

describe("bingProvider", () => {
  it("asks for one image from the resolved market", () => {
    const request = bingProvider.buildRequest(settings(), "zh-CN")
    expect(request.kind).toBe("json")
    expect(request.url).toContain("HPImageArchive.aspx")
    expect(request.url).toContain("mkt=zh-CN")
    expect(request.url).toContain("n=1")
  })

  it("puts the origin back on a root-relative image path", () => {
    const result = bingProvider.parse(
      { images: [{ url: "/th?id=OHR.Test_1920x1080.jpg", startdate: "20260903" }] },
      settings()
    )
    expect(result).toMatchObject({
      ok: true,
      candidate: { imageUrl: "https://www.bing.com/th?id=OHR.Test_1920x1080.jpg" },
    })
  })

  it("builds a UHD url from the stem when asked", () => {
    const result = bingProvider.parse(
      { images: [{ urlbase: "/th?id=OHR.Test", url: "/th?id=OHR.Test_1920x1080.jpg" }] },
      settings({ bing: { market: "auto", resolution: "uhd" } })
    )
    expect(result).toMatchObject({
      ok: true,
      candidate: { imageUrl: expect.stringContaining("_UHD.jpg") },
    })
  })

  it("falls back to the 1080p url when a UHD stem is absent", () => {
    const result = bingProvider.parse(
      { images: [{ url: "/th?id=OHR.Test_1920x1080.jpg" }] },
      settings({ bing: { market: "auto", resolution: "uhd" } })
    )
    expect(result).toMatchObject({
      ok: true,
      candidate: { imageUrl: expect.stringContaining("_1920x1080.jpg") },
    })
  })

  it("names the image from the copyright when the title is empty", () => {
    const result = bingProvider.parse(
      {
        images: [
          {
            url: "/a.jpg",
            title: "",
            copyright: "Lake Bled, Slovenia (© Some Photographer/Getty)",
          },
        ],
      },
      settings()
    )
    expect(result).toMatchObject({ ok: true, candidate: { title: "Lake Bled, Slovenia" } })
  })

  it("keeps the full copyright as attribution", () => {
    const result = bingProvider.parse(
      { images: [{ url: "/a.jpg", copyright: "Somewhere (© Someone)" }] },
      settings()
    )
    expect(result).toMatchObject({
      ok: true,
      candidate: { attribution: "Somewhere (© Someone)" },
    })
  })

  it("uses the publication date as the identity so a re-run is free", () => {
    const result = bingProvider.parse(
      { images: [{ url: "/a.jpg", startdate: "20260903" }] },
      settings()
    )
    expect(result).toMatchObject({ ok: true, candidate: { entryKey: "20260903" } })
  })

  it("reports a shape it cannot read", () => {
    expect(bingProvider.parse({}, settings())).toEqual({ ok: false, reason: "bad-response" })
    expect(bingProvider.parse({ images: [] }, settings())).toEqual({
      ok: false,
      reason: "bad-response",
    })
    expect(bingProvider.parse({ images: [{}] }, settings())).toEqual({
      ok: false,
      reason: "no-image",
    })
  })
})

describe("nasaApodProvider", () => {
  it("uses DEMO_KEY when the user supplied none", () => {
    expect(resolveNasaApiKey({ preferHd: false })).toBe("DEMO_KEY")
    expect(resolveNasaApiKey({ preferHd: false, apiKey: "   " })).toBe("DEMO_KEY")
  })

  it("uses the user's key when present", () => {
    expect(resolveNasaApiKey({ preferHd: false, apiKey: "abc123" })).toBe("abc123")
  })

  it("url-encodes the key rather than interpolating it raw", () => {
    const request = nasaApodProvider.buildRequest(
      settings({ nasaApod: { preferHd: false, apiKey: "a b&c" } }),
      "en"
    )
    expect(request.url).toContain("api_key=a%20b%26c")
  })

  it("reports a video day as unsupported media, not as a broken endpoint", () => {
    // APOD publishes a video on a meaningful fraction of days. Reporting that
    // as a failure would have users debugging a working integration.
    const result = nasaApodProvider.parse(
      { media_type: "video", url: "https://youtube.test/x", date: "2026-09-03" },
      settings()
    )
    expect(result).toEqual({ ok: false, reason: "unsupported-media" })
  })

  it("prefers the standard url by default", () => {
    const result = nasaApodProvider.parse(
      {
        media_type: "image",
        url: "https://apod.nasa.gov/small.jpg",
        hdurl: "https://apod.nasa.gov/big.jpg",
        title: "A Galaxy",
        date: "2026-09-03",
      },
      settings()
    )
    expect(result).toMatchObject({
      ok: true,
      candidate: { imageUrl: "https://apod.nasa.gov/small.jpg", title: "A Galaxy" },
    })
  })

  it("takes the HD asset when asked", () => {
    const result = nasaApodProvider.parse(
      {
        media_type: "image",
        url: "https://apod.nasa.gov/small.jpg",
        hdurl: "https://apod.nasa.gov/big.jpg",
        date: "2026-09-03",
      },
      settings({ nasaApod: { preferHd: true } })
    )
    expect(result).toMatchObject({
      ok: true,
      candidate: { imageUrl: "https://apod.nasa.gov/big.jpg" },
    })
  })

  it("falls back to the other url when the preferred one is missing", () => {
    const result = nasaApodProvider.parse(
      { media_type: "image", url: "https://apod.nasa.gov/small.jpg", date: "2026-09-03" },
      settings({ nasaApod: { preferHd: true } })
    )
    expect(result).toMatchObject({
      ok: true,
      candidate: { imageUrl: "https://apod.nasa.gov/small.jpg" },
    })
  })

  it("allowlists the image host as well as the api host", () => {
    // APOD serves images from a different host than its API, so an allowlist
    // covering only api.nasa.gov would block every download.
    expect(nasaApodProvider.allowedHosts).toContain("api.nasa.gov")
    expect(nasaApodProvider.allowedHosts).toContain("apod.nasa.gov")
  })
})

describe("customProvider", () => {
  it("treats a direct image url as the image", () => {
    const result = customProvider.parse(
      null,
      settings({ custom: { url: "https://example.test/a.jpg", kind: "image" } })
    )
    expect(result).toMatchObject({
      ok: true,
      candidate: { imageUrl: "https://example.test/a.jpg" },
    })
  })

  it("reads the image url out of a json response by path", () => {
    const result = customProvider.parse(
      { data: { picture: "https://example.test/b.jpg" } },
      settings({
        custom: { url: "https://example.test/api", kind: "json", imagePath: "data.picture" },
      })
    )
    expect(result).toMatchObject({
      ok: true,
      candidate: { imageUrl: "https://example.test/b.jpg" },
    })
  })

  it("reads an optional title", () => {
    const result = customProvider.parse(
      { pic: "https://example.test/b.jpg", name: "Sunset" },
      settings({
        custom: {
          url: "https://example.test/api",
          kind: "json",
          imagePath: "pic",
          titlePath: "name",
        },
      })
    )
    expect(result).toMatchObject({ ok: true, candidate: { title: "Sunset" } })
  })

  it("reports a path that resolves to nothing", () => {
    const result = customProvider.parse(
      { other: 1 },
      settings({
        custom: { url: "https://example.test/api", kind: "json", imagePath: "data.picture" },
      })
    )
    expect(result).toEqual({ ok: false, reason: "no-image" })
  })

  it("requires a path for a json source", () => {
    const result = customProvider.parse(
      { a: 1 },
      settings({ custom: { url: "https://example.test/api", kind: "json" } })
    )
    expect(result).toEqual({ ok: false, reason: "no-image" })
  })

  it("declares no allowlist, because the user named the host", () => {
    expect(customProvider.allowedHosts).toEqual([])
  })
})

describe("resolveCustomImageUrl", () => {
  const source = { url: "https://example.test/api/today", kind: "json" as const }

  it("passes an absolute url straight through", () => {
    expect(resolveCustomImageUrl("https://cdn.test/a.jpg", source)).toBe("https://cdn.test/a.jpg")
  })

  it("resolves a relative path against the endpoint origin", () => {
    expect(resolveCustomImageUrl("/img/a.jpg", source)).toBe("https://example.test/img/a.jpg")
  })

  it("prefers an explicit base url", () => {
    expect(resolveCustomImageUrl("/a.jpg", { ...source, baseUrl: "https://cdn.test" })).toBe(
      "https://cdn.test/a.jpg"
    )
  })

  it("returns null when there is no origin to resolve against", () => {
    expect(resolveCustomImageUrl("/a.jpg", { url: "not a url", kind: "json" })).toBeNull()
  })
})

describe("isAllowedProviderHost", () => {
  it("accepts the exact host and its subdomains", () => {
    expect(isAllowedProviderHost("https://bing.com/a", ["bing.com"])).toBe(true)
    expect(isAllowedProviderHost("https://www.bing.com/a", ["bing.com"])).toBe(true)
  })

  it("rejects a lookalike suffix", () => {
    // The attack this closes: a JSON response naming an image on a host that
    // merely ENDS with the allowed string.
    expect(isAllowedProviderHost("https://notbing.com/a", ["bing.com"])).toBe(false)
    expect(isAllowedProviderHost("https://bing.com.evil.test/a", ["bing.com"])).toBe(false)
  })

  it("rejects plain http even on an allowed host", () => {
    expect(isAllowedProviderHost("http://bing.com/a", ["bing.com"])).toBe(false)
  })

  it("rejects an unparseable url", () => {
    expect(isAllowedProviderHost("//not a url", ["bing.com"])).toBe(false)
  })

  it("is case-insensitive about the host", () => {
    expect(isAllowedProviderHost("https://WWW.Bing.COM/a", ["bing.com"])).toBe(true)
  })

  it("permits anything when the allowlist is empty, which is the custom source", () => {
    expect(isAllowedProviderHost("https://anything.test/a", [])).toBe(true)
  })
})

describe("getDailyWallpaperProvider", () => {
  it("resolves each built-in id", () => {
    expect(getDailyWallpaperProvider("bing").id).toBe("bing")
    expect(getDailyWallpaperProvider("nasaApod").id).toBe("nasaApod")
    expect(getDailyWallpaperProvider("custom").id).toBe("custom")
  })

  it("falls back to bing for an unknown id from a restored settings row", () => {
    expect(getDailyWallpaperProvider("nope" as "bing").id).toBe("bing")
  })
})
