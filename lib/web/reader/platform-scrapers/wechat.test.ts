import { scrapeWeChat } from "./wechat"

function res(body: string, opts: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: () => "text/html" },
    text: async () => body,
  } as unknown as Response
}

const ARTICLE = `<html><head><meta property="og:title" content="OG Title"></head>
  <body>
    <h1 id="activity-name">  Real Title </h1>
    <div id="js_content"><p>Hello <a href="https://e.com">link</a></p><p>Second</p></div>
  </body></html>`

describe("scrapeWeChat", () => {
  it("extracts the title and js_content as markdown", async () => {
    const fetchImpl = jest.fn(async () => res(ARTICLE))
    const r = await scrapeWeChat(
      "https://mp.weixin.qq.com/s/abc",
      fetchImpl as unknown as typeof fetch
    )
    expect(r?.title).toBe("Real Title")
    expect(r?.source).toBe("wechat")
    expect(r?.markdown).toContain("Hello")
    expect(r?.markdown).toContain("[link](https://e.com)")
    expect(r?.markdown).toContain("Second")
  })

  it("falls back to og:title when #activity-name is absent", async () => {
    const html = `<html><head><meta property="og:title" content="OG Title"></head><body><div id="js_content"><p>Body</p></div></body></html>`
    const fetchImpl = jest.fn(async () => res(html))
    const r = await scrapeWeChat(
      "https://mp.weixin.qq.com/s/x",
      fetchImpl as unknown as typeof fetch
    )
    expect(r?.title).toBe("OG Title")
  })

  it("returns null when #js_content is missing", async () => {
    const fetchImpl = jest.fn(async () => res("<html><body>no content</body></html>"))
    expect(await scrapeWeChat("u", fetchImpl as unknown as typeof fetch)).toBeNull()
  })

  it("returns null on a non-ok response", async () => {
    const fetchImpl = jest.fn(async () => res("x", { ok: false, status: 404 }))
    expect(await scrapeWeChat("u", fetchImpl as unknown as typeof fetch)).toBeNull()
  })

  it("returns null when the fetch throws", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("net")
    })
    expect(await scrapeWeChat("u", fetchImpl as unknown as typeof fetch)).toBeNull()
  })
})
