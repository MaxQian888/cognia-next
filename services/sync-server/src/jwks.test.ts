import { describe, expect, it, vi } from "vitest"

import { createJwksCache, JWKS_MIN_REFRESH_MS, JWKS_TTL_MS, jwksFetcher } from "./jwks"

const JWKS = { keys: [{ kty: "EC", kid: "a" }] }

describe("createJwksCache", () => {
  it("fetches once, then serves from cache until the TTL", async () => {
    let now = 0
    const fetchJwks = vi.fn(async () => Response.json(JWKS))
    const cache = createJwksCache(fetchJwks, () => now)
    await Promise.all([cache.get(), cache.get()])
    expect(fetchJwks).toHaveBeenCalledTimes(1)
    now = JWKS_TTL_MS - 1
    await cache.get()
    expect(fetchJwks).toHaveBeenCalledTimes(1)
    now = JWKS_TTL_MS
    await cache.get()
    expect(fetchJwks).toHaveBeenCalledTimes(2)
  })

  it("refreshes at most once a minute", async () => {
    let now = 0
    const fetchJwks = vi.fn(async () => Response.json(JWKS))
    const cache = createJwksCache(fetchJwks, () => now)
    await cache.get()
    expect(await cache.refresh()).toBe(false)
    now = JWKS_MIN_REFRESH_MS
    expect(await cache.refresh()).toBe(true)
    expect(fetchJwks).toHaveBeenCalledTimes(2)
  })

  it("refuses an error answer or a malformed key set, and retries next time", async () => {
    const answers = [
      new Response("no", { status: 503 }),
      Response.json({ nope: 1 }),
      Response.json(JWKS),
    ]
    const cache = createJwksCache(async () => answers.shift()!)
    await expect(cache.get()).rejects.toThrow(/503/)
    await expect(cache.get()).rejects.toThrow(/malformed/)
    await expect(cache.get()).resolves.toEqual(JWKS)
  })
})

describe("jwksFetcher", () => {
  it("uses the service binding when there is one", async () => {
    const binding = {
      fetch: vi.fn(async (url: string) => Response.json({ url })),
    } as unknown as Fetcher
    const response = await jwksFetcher("https://id.test/api/auth", binding)()
    expect(await response.json()).toEqual({ url: "https://id.test/api/auth/jwks" })
  })
})
