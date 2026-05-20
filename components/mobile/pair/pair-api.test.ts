/**
 * @jest-environment jsdom
 */

import { redeemPairCode, redeemPairJwt, type PairFetcher } from "./pair-api"

function makeFetcher(handler: (url: string, init: RequestInit) => Response): PairFetcher {
  return jest.fn((url: string, init: RequestInit) =>
    Promise.resolve(handler(url, init))
  ) as unknown as PairFetcher
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const validPairBody = {
  device_id: "device-1",
  device_jwt: "eyJ.device.jwt",
  server_version: "0.1.0",
  rendezvous_id: "rendez-1",
  rendezvous_secret: "secret-bytes",
}

describe("redeemPairJwt", () => {
  it("returns ok with CompanionConfig on 200", async () => {
    const fetcher = makeFetcher((url, init) => {
      expect(url).toBe("https://10.0.2.2:7890/api/v1/auth/pair")
      expect(JSON.parse(init.body as string)).toMatchObject({
        pair_jwt: "eyJ.pair.jwt",
        device_label: expect.any(String),
        device_platform: expect.any(String),
      })
      return jsonResponse(200, validPairBody)
    })
    const result = await redeemPairJwt(
      {
        baseUrl: "https://10.0.2.2:7890",
        pairJwt: "eyJ.pair.jwt",
      },
      fetcher
    )
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.config.deviceId).toBe("device-1")
      expect(result.config.deviceJwt).toBe("eyJ.device.jwt")
      expect(result.config.rendezvousId).toBe("rendez-1")
      expect(result.config.rendezvousSecret).toBe("secret-bytes")
    }
  })

  it("strips trailing slash on baseUrl", async () => {
    const seen: string[] = []
    const fetcher = makeFetcher((url) => {
      seen.push(url)
      return jsonResponse(200, validPairBody)
    })
    const result = await redeemPairJwt(
      { baseUrl: "https://10.0.2.2:7890///", pairJwt: "eyJ.pair.jwt" },
      fetcher
    )
    expect(seen[0]).toBe("https://10.0.2.2:7890/api/v1/auth/pair")
    if (result.kind === "ok") {
      expect(result.config.baseUrl).toBe("https://10.0.2.2:7890")
    }
  })

  it("propagates serverFingerprint into the request and config", async () => {
    const fetcher = makeFetcher((_url, init) => {
      expect((init as { serverFingerprint?: string }).serverFingerprint).toBe("ABCDEF")
      return jsonResponse(200, validPairBody)
    })
    const result = await redeemPairJwt(
      {
        baseUrl: "https://10.0.2.2:7890",
        pairJwt: "eyJ.pair.jwt",
        serverFingerprint: "ABCDEF",
      },
      fetcher
    )
    if (result.kind === "ok") {
      expect(result.config.serverFingerprint).toBe("ABCDEF")
    }
  })
})

describe("redeemPairCode", () => {
  it("returns ok on 200 with device JWT", async () => {
    const fetcher = makeFetcher((url, init) => {
      expect(url).toBe("https://10.0.2.2:7890/api/v1/auth/pair/redeem-code")
      expect(JSON.parse(init.body as string)).toMatchObject({
        code: "123456",
        device_label: expect.any(String),
      })
      return jsonResponse(200, validPairBody)
    })
    const result = await redeemPairCode(
      { baseUrl: "https://10.0.2.2:7890", code: "123456" },
      fetcher
    )
    expect(result.kind).toBe("ok")
  })

  it("rejects non-6-digit codes locally without calling fetcher", async () => {
    const fetcher = jest.fn() as unknown as PairFetcher
    for (const bad of ["12345", "1234567", "12345a", "", "abcdef"]) {
      const result = await redeemPairCode({ baseUrl: "https://10.0.2.2:7890", code: bad }, fetcher)
      expect(result.kind).toBe("code_error")
      if (result.kind === "code_error") {
        expect(result.code).toBe("invalid_pair_code")
      }
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("trims whitespace before validating", async () => {
    const fetcher = makeFetcher(() => jsonResponse(200, validPairBody))
    const result = await redeemPairCode(
      { baseUrl: "https://10.0.2.2:7890", code: "  123456  " },
      fetcher
    )
    expect(result.kind).toBe("ok")
  })

  it("maps pair_code_not_found onto code_error", async () => {
    const fetcher = makeFetcher(() =>
      jsonResponse(404, {
        code: "pair_code_not_found",
        message: "pair code is unknown or already used",
      })
    )
    const result = await redeemPairCode(
      { baseUrl: "https://10.0.2.2:7890", code: "654321" },
      fetcher
    )
    expect(result.kind).toBe("code_error")
    if (result.kind === "code_error") {
      expect(result.code).toBe("pair_code_not_found")
    }
  })

  it("maps pair_code_expired onto code_error", async () => {
    const fetcher = makeFetcher(() =>
      jsonResponse(410, {
        code: "pair_code_expired",
        message: "pair code has expired",
      })
    )
    const result = await redeemPairCode(
      { baseUrl: "https://10.0.2.2:7890", code: "111111" },
      fetcher
    )
    expect(result.kind).toBe("code_error")
    if (result.kind === "code_error") {
      expect(result.code).toBe("pair_code_expired")
    }
  })

  it("falls back to http_error for unknown error codes", async () => {
    const fetcher = makeFetcher(() =>
      jsonResponse(500, {
        code: "internal_explosion",
        message: "boom",
      })
    )
    const result = await redeemPairCode(
      { baseUrl: "https://10.0.2.2:7890", code: "654321" },
      fetcher
    )
    expect(result.kind).toBe("http_error")
    if (result.kind === "http_error") {
      expect(result.status).toBe(500)
    }
  })

  it("falls back to http_error when body is not JSON", async () => {
    const fetcher = makeFetcher(() => new Response("not json", { status: 503 }))
    const result = await redeemPairCode(
      { baseUrl: "https://10.0.2.2:7890", code: "654321" },
      fetcher
    )
    expect(result.kind).toBe("http_error")
    if (result.kind === "http_error") {
      expect(result.status).toBe(503)
      expect(result.rawBody).toBe("not json")
    }
  })

  it("returns network_error on thrown fetch", async () => {
    const fetcher = jest.fn(() =>
      Promise.reject(new Error("connection refused"))
    ) as unknown as PairFetcher
    const result = await redeemPairCode(
      { baseUrl: "https://10.0.2.2:7890", code: "654321" },
      fetcher
    )
    expect(result.kind).toBe("network_error")
    if (result.kind === "network_error") {
      expect(result.message).toBe("connection refused")
    }
  })

  it("omits rendezvous fields when legacy server returns none", async () => {
    const fetcher = makeFetcher(() =>
      jsonResponse(200, {
        device_id: "d",
        device_jwt: "j",
        server_version: "0.1.0",
      })
    )
    const result = await redeemPairCode(
      { baseUrl: "https://10.0.2.2:7890", code: "654321" },
      fetcher
    )
    if (result.kind === "ok") {
      expect(result.config.rendezvousId).toBeUndefined()
      expect(result.config.rendezvousSecret).toBeUndefined()
    }
  })
})
