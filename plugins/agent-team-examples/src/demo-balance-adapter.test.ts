import { demoBalanceAdapter } from "./demo-balance-adapter"
import type { BalanceQuery } from "@cognia/plugin-sdk"
const q: BalanceQuery = {
  accountId: "acc-1",
  providerKey: "example-credits",
  baseUrl: "https://credits.example.com/",
  token: "sk-demo",
}

describe("demoBalanceAdapter", () => {
  it("matches by providerKey and by baseUrl host", () => {
    expect(demoBalanceAdapter.matches({ providerKey: "example-credits" })).toBe(true)
    expect(demoBalanceAdapter.matches({ baseUrl: "https://credits.example.com/v1" })).toBe(true)
    expect(demoBalanceAdapter.matches({ providerKey: "deepseek" })).toBe(false)
  })

  it("builds an authed GET descriptor with a trimmed base URL", () => {
    const req = demoBalanceAdapter.request(q)
    expect(req.url).toBe("https://credits.example.com/v1/balance")
    expect(req.headers.authorization).toBe("Bearer sk-demo")
  })

  it("parses a successful balance payload", () => {
    const snap = demoBalanceAdapter.parse(200, JSON.stringify({ balance: 7.5, currency: "USD" }), q)
    expect(snap.remaining).toBe(7.5)
    expect(snap.currency).toBe("USD")
    expect(snap.unit).toBe("USD")
    expect(snap.error).toBeUndefined()
  })

  it("returns an error snapshot on a non-200 status", () => {
    const snap = demoBalanceAdapter.parse(401, "nope", q)
    expect(snap.error).toBe("HTTP 401")
    expect(snap.remaining).toBeUndefined()
  })

  it("returns an error snapshot on an unparseable body", () => {
    const snap = demoBalanceAdapter.parse(200, "<<not json>>", q)
    expect(snap.error).toMatch(/Unparseable/)
  })
})
