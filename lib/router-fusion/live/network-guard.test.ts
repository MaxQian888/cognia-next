import { installNetworkGuard, LiveSmokeNetworkBlockedError } from "./network-guard"

function ticking(): () => number {
  let t = 0
  return () => (t += 10)
}

describe("installNetworkGuard", () => {
  it("blocks every request in block mode, records it without its query, and never reaches the original", async () => {
    const original = jest.fn()
    const target: { fetch?: unknown } = { fetch: original }
    const guard = installNetworkGuard("block", { now: ticking(), target })
    const guarded = target.fetch as (input: unknown, init?: unknown) => Promise<unknown>
    await expect(
      guarded("https://api.example.com/v1/chat?key=secret", { method: "post" })
    ).rejects.toBeInstanceOf(LiveSmokeNetworkBlockedError)
    await expect(guarded(new URL("https://other.example.com/x"))).rejects.toThrow(
      "https://other.example.com/x"
    )
    expect(original).not.toHaveBeenCalled()
    expect(guard.records).toEqual([
      {
        method: "POST",
        host: "api.example.com",
        url: "https://api.example.com/v1/chat",
        status: null,
        durationMs: 0,
        retryAfter: null,
        blocked: true,
      },
      expect.objectContaining({ method: "GET", host: "other.example.com", blocked: true }),
    ])
    guard.restore()
    expect(target.fetch).toBe(original)
  })

  it("passes requests through in observe mode and records status, retry-after and duration", async () => {
    const response = {
      status: 429,
      headers: { get: (name: string) => (name === "retry-after" ? "2" : null) },
    }
    const original = jest.fn(async () => response)
    const target: { fetch?: unknown } = { fetch: original }
    const guard = installNetworkGuard("observe", { now: ticking(), target })
    const guarded = target.fetch as (input: unknown, init?: unknown) => Promise<unknown>
    const request = { url: "https://api.anthropic.com/v1/messages", method: "POST" }
    await expect(guarded(request)).resolves.toBe(response)
    expect(original).toHaveBeenCalledWith(request, undefined)
    expect(guard.records).toEqual([
      {
        method: "POST",
        host: "api.anthropic.com",
        url: "https://api.anthropic.com/v1/messages",
        status: 429,
        durationMs: 10,
        retryAfter: "2",
        blocked: false,
      },
    ])
    guard.restore()
  })

  it("blocks in observe mode too when there is no fetch to pass to", async () => {
    const target: { fetch?: unknown } = {}
    const guard = installNetworkGuard("observe", { now: ticking(), target })
    await expect(
      (target.fetch as (input: unknown) => Promise<unknown>)("https://x.test/")
    ).rejects.toBeInstanceOf(LiveSmokeNetworkBlockedError)
    guard.restore()
    expect("fetch" in target).toBe(false)
  })

  it("restores once, and guards the global fetch by default", () => {
    const before = globalThis.fetch
    const guard = installNetworkGuard("block", { now: ticking() })
    expect(globalThis.fetch).not.toBe(before)
    guard.restore()
    guard.restore()
    expect(globalThis.fetch).toBe(before)
  })
})
