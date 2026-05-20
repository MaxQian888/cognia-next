/**
 * @jest-environment jsdom
 */

import { fetchHealthz } from "./healthz"

type FetchShim = { status: number; json: () => Promise<unknown> }

function makeFetch(handler: (url: string) => FetchShim) {
  return jest.fn((url: string | URL | Request) =>
    Promise.resolve(handler(typeof url === "string" ? url : url.toString()))
  ) as unknown as typeof fetch
}

const validHealthzBody = {
  version: "0.1.0",
  fingerprint: "ab".repeat(32),
  advertised_port: 7890,
  server_id: "0123456789abcdef0123456789abcdef",
}

describe("fetchHealthz", () => {
  it("returns parsed result on 200 with snake_case fields", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      json: () => Promise.resolve(validHealthzBody),
    }))
    const ctrl = new AbortController()
    const result = await fetchHealthz("https://10.0.2.2:7890", {
      signal: ctrl.signal,
      fetchImpl,
    })
    expect(result).toEqual({
      version: "0.1.0",
      fingerprint: validHealthzBody.fingerprint,
      advertisedPort: 7890,
      serverId: validHealthzBody.server_id,
    })
  })

  it("also accepts camelCase variants for forward-compat", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      json: () =>
        Promise.resolve({
          version: "0.2.0",
          fingerprint: "ff".repeat(32),
          advertisedPort: 7900,
          serverId: "ffffffffffffffffffffffffffffffff",
        }),
    }))
    const ctrl = new AbortController()
    const result = await fetchHealthz("https://10.0.2.2:7900", {
      signal: ctrl.signal,
      fetchImpl,
    })
    expect(result?.advertisedPort).toBe(7900)
    expect(result?.serverId).toBe("ffffffffffffffffffffffffffffffff")
  })

  it("strips trailing slash on baseUrl", async () => {
    const fetchImpl = makeFetch((url) => {
      expect(url).toBe("https://10.0.2.2:7890/api/v1/healthz")
      return { status: 200, json: () => Promise.resolve(validHealthzBody) }
    })
    const ctrl = new AbortController()
    await fetchHealthz("https://10.0.2.2:7890/", {
      signal: ctrl.signal,
      fetchImpl,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("returns null on non-200 response", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 404,
      json: () => Promise.resolve(validHealthzBody),
    }))
    const ctrl = new AbortController()
    const result = await fetchHealthz("https://10.0.2.2:7890", {
      signal: ctrl.signal,
      fetchImpl,
    })
    expect(result).toBeNull()
  })

  it("returns null when required fields are missing", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      json: () =>
        Promise.resolve({
          version: "0.1.0",
          // fingerprint missing
          advertised_port: 7890,
          server_id: "abc",
        }),
    }))
    const ctrl = new AbortController()
    const result = await fetchHealthz("https://10.0.2.2:7890", {
      signal: ctrl.signal,
      fetchImpl,
    })
    expect(result).toBeNull()
  })

  it("returns null when body is not an object", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      json: () => Promise.resolve("not an object"),
    }))
    const ctrl = new AbortController()
    const result = await fetchHealthz("https://10.0.2.2:7890", {
      signal: ctrl.signal,
      fetchImpl,
    })
    expect(result).toBeNull()
  })

  it("returns null when fetch throws", async () => {
    const fetchImpl = jest.fn(() =>
      Promise.reject(new Error("network unreachable"))
    ) as unknown as typeof fetch
    const ctrl = new AbortController()
    const result = await fetchHealthz("https://10.0.2.2:7890", {
      signal: ctrl.signal,
      fetchImpl,
    })
    expect(result).toBeNull()
  })

  it("returns null when called with already-aborted signal", async () => {
    const fetchImpl = jest.fn()
    const ctrl = new AbortController()
    ctrl.abort()
    const result = await fetchHealthz("https://10.0.2.2:7890", {
      signal: ctrl.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("returns null on body json parse failure", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      json: () => Promise.reject(new Error("not json")),
    }))
    const ctrl = new AbortController()
    const result = await fetchHealthz("https://10.0.2.2:7890", {
      signal: ctrl.signal,
      fetchImpl,
    })
    expect(result).toBeNull()
  })
})
