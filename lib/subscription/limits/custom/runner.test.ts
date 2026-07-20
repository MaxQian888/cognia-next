import {
  __resetCustomLimitsRunnerForTesting,
  customProviderId,
  runCustomLimitsSource,
  runCustomLimitsSources,
} from "./runner"

import type { CustomLimitsSource } from "@/types/subscription"

function src(over: Partial<CustomLimitsSource> = {}): CustomLimitsSource {
  return {
    id: "relay1",
    name: "My Relay",
    baseUrl: "https://relay.example.com/v1",
    token: "tok",
    enabled: true,
    request: { path: "/balance" },
    extract: { kind: "balance", remainingPath: "data.balance", unit: "USD", currency: "USD" },
    ...over,
  }
}

const deps = (authedGet: (url: string, h?: Record<string, string>) => Promise<string>) => ({
  authedGet,
  now: () => 1_000_000,
})

beforeEach(() => {
  __resetCustomLimitsRunnerForTesting()
})

describe("customProviderId", () => {
  it("namespaces the id", () => {
    expect(customProviderId("relay1")).toBe("custom:relay1")
  })
})

describe("runCustomLimitsSource", () => {
  it("runs a complete source and tags the snapshot custom:<id> with the name", async () => {
    const snap = await runCustomLimitsSource(
      src(),
      deps(async (url) => {
        expect(url).toBe("https://relay.example.com/v1/balance")
        return JSON.stringify({ data: { balance: 7.5 } })
      })
    )
    expect(snap?.provider).toBe("custom:relay1")
    expect(snap?.accountLabel).toBe("My Relay")
    expect(snap?.meters[0]).toMatchObject({ kind: "balance", remaining: 7.5, unit: "USD" })
  })

  it("returns null for an incomplete source without calling the network", async () => {
    let called = false
    const snap = await runCustomLimitsSource(
      src({ token: "" }),
      deps(async () => {
        called = true
        return "{}"
      })
    )
    expect(snap).toBeNull()
    expect(called).toBe(false)
  })
})

describe("runCustomLimitsSources", () => {
  it("does not query sources that are not explicitly enabled", async () => {
    const authedGet = jest.fn(async () => JSON.stringify({ data: { balance: 7 } }))
    const out = await runCustomLimitsSources(
      [src({ enabled: false })],
      deps(authedGet)
    )

    expect(out).toEqual([])
    expect(authedGet).not.toHaveBeenCalled()
  })

  it("replays the last successful result inside the source refresh interval", async () => {
    let clock = 1_000
    const authedGet = jest.fn(async () => JSON.stringify({ data: { balance: 7 } }))
    const source = src({ enabled: true, refreshIntervalMs: 15 * 60_000 })
    const runnerDeps = { authedGet, now: () => clock }

    const first = await runCustomLimitsSources([source], runnerDeps)
    clock += 60_000
    const replayed = await runCustomLimitsSources([source], runnerDeps)

    expect(authedGet).toHaveBeenCalledTimes(1)
    expect(replayed).toEqual(first)
  })

  it("drops incomplete sources and keeps the complete ones", async () => {
    const sources = [src({ id: "ok" }), src({ id: "bad", name: "" }), src({ id: "ok2" })]
    const out = await runCustomLimitsSources(
      sources,
      deps(async () => JSON.stringify({ data: { balance: 1 } }))
    )
    expect(out.map((s) => s.provider).sort()).toEqual(["custom:ok", "custom:ok2"])
  })

  it("surfaces a thrown GET as an error snapshot (per-source, not whole batch)", async () => {
    let n = 0
    const out = await runCustomLimitsSources(
      [src({ id: "a" }), src({ id: "b" })],
      deps(async () => {
        n += 1
        if (n === 1) throw new Error("HTTP 401")
        return JSON.stringify({ data: { balance: 2 } })
      })
    )
    expect(out).toHaveLength(2)
    const errored = out.find((s) => s.error)
    const ok = out.find((s) => s.meters.length > 0)
    expect(errored?.error).toBe("HTTP 401")
    expect(ok?.meters[0]).toMatchObject({ remaining: 2 })
  })
})
