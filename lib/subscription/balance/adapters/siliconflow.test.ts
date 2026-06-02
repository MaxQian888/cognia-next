import type { BalanceQuery } from "@/types/subscription"

import { siliconflowBalanceAdapter as a } from "./siliconflow"

const Q: BalanceQuery = {
  accountId: "acc-1",
  providerKey: "siliconflow",
  baseUrl: "https://api.siliconflow.cn/v1",
  token: "sk-sf-test",
}

const FIXTURE = JSON.stringify({
  code: 20000,
  status: true,
  data: { id: "u1", balance: "0.88", chargeBalance: "88.00", totalBalance: "88.88" },
})

describe("siliconflowBalanceAdapter", () => {
  it("matches by providerKey and host", () => {
    expect(a.matches({ providerKey: "siliconflow" })).toBe(true)
    expect(a.matches({ baseUrl: "https://api.siliconflow.cn/v1" })).toBe(true)
    expect(a.matches({ baseUrl: "https://api.siliconflow.com/v1" })).toBe(true)
    expect(a.matches({ providerKey: "moonshot" })).toBe(false)
    expect(a.matches({})).toBe(false)
  })

  it("builds the /user/info request", () => {
    const req = a.request(Q)
    expect(req.url).toBe("https://api.siliconflow.cn/v1/user/info")
    expect(req.headers.Authorization).toBe("Bearer sk-sf-test")
  })

  it("parses CNY balance + total", () => {
    const snap = a.parse(200, FIXTURE, Q)
    expect(snap.kind).toBe("credit")
    expect(snap.remaining).toBe(0.88)
    expect(snap.total).toBe(88.88)
    expect(snap.currency).toBe("CNY")
  })

  it("errors on non-2xx and missing data", () => {
    expect(a.parse(403, "{}", Q).error).toBe("HTTP 403")
    expect(a.parse(200, JSON.stringify({ code: 20000 }), Q).error).toBe("no data")
  })
})
