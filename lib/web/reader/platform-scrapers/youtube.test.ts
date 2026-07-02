import {
  decodeEntities,
  extractJsonAfter,
  extractVideoId,
  parseTimedText,
  scrapeYouTube,
} from "./youtube"

function res(body: string, opts: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: () => "text/html" },
    text: async () => body,
  } as unknown as Response
}

describe("extractVideoId", () => {
  it("handles watch, youtu.be, shorts and embed URLs", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=abc123")).toBe("abc123")
    expect(extractVideoId("https://youtu.be/abc123")).toBe("abc123")
    expect(extractVideoId("https://www.youtube.com/shorts/abc123")).toBe("abc123")
    expect(extractVideoId("https://www.youtube.com/embed/abc123")).toBe("abc123")
  })

  it("returns null for a non-video URL", () => {
    expect(extractVideoId("https://www.youtube.com/feed/subscriptions")).toBeNull()
    expect(extractVideoId("not a url")).toBeNull()
  })
})

describe("extractJsonAfter", () => {
  it("extracts the first balanced object after the marker", () => {
    expect(extractJsonAfter('var foo = {"a":{"b":1}}; var x = 2', "foo")).toBe('{"a":{"b":1}}')
  })

  it("respects braces inside string literals", () => {
    expect(extractJsonAfter('foo = {"s":"}{"} ;', "foo")).toBe('{"s":"}{"}')
  })

  it("returns null when the marker or object is absent", () => {
    expect(extractJsonAfter("no marker here", "foo")).toBeNull()
    expect(extractJsonAfter("foo = not-an-object", "foo")).toBeNull()
  })
})

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities", () => {
    expect(decodeEntities("a &amp; b &lt; c &#39;d&#39; &#x41;")).toBe("a & b < c 'd' A")
  })
})

describe("parseTimedText", () => {
  it("joins <text> nodes and decodes entities", () => {
    const xml = '<text start="0">a &amp;amp; b</text><text start="1">c</text>'
    expect(parseTimedText(xml)).toBe("a & b c")
  })
})

describe("scrapeYouTube", () => {
  const player = {
    videoDetails: { title: "Vid", shortDescription: "the description", author: "Chan" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{ baseUrl: "https://caption/track", languageCode: "en" }],
      },
    },
  }
  const watchHtml = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script></html>`

  it("assembles title + description + transcript", async () => {
    const fetchImpl = jest.fn(async (url: string) =>
      url.includes("/watch") ? res(watchHtml) : res("<text>hello there</text>")
    )
    const r = await scrapeYouTube(
      "https://www.youtube.com/watch?v=abc",
      fetchImpl as unknown as typeof fetch
    )
    expect(r?.source).toBe("youtube")
    expect(r?.title).toBe("Vid")
    expect(r?.markdown).toContain("# Vid")
    expect(r?.markdown).toContain("the description")
    expect(r?.markdown).toContain("hello there")
  })

  it("still returns title + description when captions are missing", async () => {
    const noCaps = { videoDetails: { title: "V", shortDescription: "d" } }
    const html = `<html><script>ytInitialPlayerResponse = ${JSON.stringify(noCaps)};</script></html>`
    const fetchImpl = jest.fn(async () => res(html))
    const r = await scrapeYouTube("https://youtu.be/abc", fetchImpl as unknown as typeof fetch)
    expect(r?.markdown).toContain("# V")
    expect(r?.markdown).not.toContain("Transcript")
  })

  it("returns null when no player response is present", async () => {
    const fetchImpl = jest.fn(async () => res("<html>nothing</html>"))
    expect(
      await scrapeYouTube("https://youtu.be/abc", fetchImpl as unknown as typeof fetch)
    ).toBeNull()
  })

  it("returns null when the URL has no video id", async () => {
    const fetchImpl = jest.fn(async () => res(watchHtml))
    expect(
      await scrapeYouTube("https://www.youtube.com/feed", fetchImpl as unknown as typeof fetch)
    ).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
