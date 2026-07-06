import { extractTweetId, scrapeX } from "./x-twitter"

function jsonRes(obj: unknown, opts: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(obj),
    json: async () => obj,
  } as unknown as Response
}

describe("extractTweetId", () => {
  it("pulls the id from /status/ and /statuses/ paths", () => {
    expect(extractTweetId("https://x.com/jane/status/123")).toBe("123")
    expect(extractTweetId("https://twitter.com/jane/statuses/456")).toBe("456")
  })

  it("returns null when there is no status id", () => {
    expect(extractTweetId("https://x.com/home")).toBeNull()
  })
})

describe("scrapeX", () => {
  const tweet = {
    tweet: {
      text: "hello world",
      author: { name: "Jane", screen_name: "jane" },
      media: { photos: [{ url: "https://p/1" }] },
      quote: { text: "quoted", author: { name: "Bob" } },
    },
  }

  it("renders a tweet via the fxtwitter API", async () => {
    const fetchImpl = jest.fn(async () => jsonRes(tweet))
    const r = await scrapeX("https://x.com/jane/status/123", fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.fxtwitter.com/status/123",
      expect.objectContaining({ method: "GET" })
    )
    expect(r?.source).toBe("x")
    expect(r?.markdown).toContain("hello world")
    expect(r?.markdown).toContain("Jane")
    expect(r?.markdown).toContain("![image](https://p/1)")
    expect(r?.markdown).toContain("> ")
    expect(r?.title).toContain("Jane")
  })

  it("returns null when the URL has no tweet id", async () => {
    const fetchImpl = jest.fn(async () => jsonRes(tweet))
    expect(await scrapeX("https://x.com/home", fetchImpl as unknown as typeof fetch)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("returns null when the API has no tweet text", async () => {
    const fetchImpl = jest.fn(async () => jsonRes({ code: 404 }))
    expect(
      await scrapeX("https://x.com/j/status/1", fetchImpl as unknown as typeof fetch)
    ).toBeNull()
  })

  it("returns null on a non-ok response", async () => {
    const fetchImpl = jest.fn(async () => jsonRes({}, { ok: false, status: 500 }))
    expect(
      await scrapeX("https://x.com/j/status/1", fetchImpl as unknown as typeof fetch)
    ).toBeNull()
  })
})
