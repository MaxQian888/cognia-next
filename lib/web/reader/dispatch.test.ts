import { scrapePlatform } from "./dispatch"

function res(body: string, contentType = "text/html"): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => contentType },
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response
}

describe("scrapePlatform", () => {
  it("routes mp.weixin.qq.com to the WeChat scraper", async () => {
    const html = `<html><body><h1 id="activity-name">T</h1><div id="js_content"><p>Body</p></div></body></html>`
    const fetchImpl = jest.fn(async () => res(html))
    const r = await scrapePlatform(
      "https://mp.weixin.qq.com/s/abc",
      fetchImpl as unknown as typeof fetch
    )
    expect(r?.source).toBe("wechat")
  })

  it("routes x.com and twitter.com to the X scraper", async () => {
    const fetchImpl = jest.fn(async () =>
      res(JSON.stringify({ tweet: { text: "hi" } }), "application/json")
    )
    const r = await scrapePlatform(
      "https://twitter.com/j/status/1",
      fetchImpl as unknown as typeof fetch
    )
    expect(r?.source).toBe("x")
  })

  it("routes youtube.com to the YouTube scraper", async () => {
    const player = { videoDetails: { title: "V", shortDescription: "d" } }
    const html = `<script>ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`
    const fetchImpl = jest.fn(async () => res(html))
    const r = await scrapePlatform(
      "https://www.youtube.com/watch?v=abc",
      fetchImpl as unknown as typeof fetch
    )
    expect(r?.source).toBe("youtube")
  })

  it("returns null (no network) for an unknown host", async () => {
    const fetchImpl = jest.fn(async () => res("x"))
    expect(
      await scrapePlatform("https://example.com/a", fetchImpl as unknown as typeof fetch)
    ).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("returns null for a malformed URL", async () => {
    const fetchImpl = jest.fn(async () => res("x"))
    expect(await scrapePlatform("not a url", fetchImpl as unknown as typeof fetch)).toBeNull()
  })
})
