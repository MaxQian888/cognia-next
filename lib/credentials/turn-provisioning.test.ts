const mockIsTauri = jest.fn().mockReturnValue(false)
const mockTransportCall = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri(),
  transport: { call: (...args: unknown[]) => mockTransportCall(...args) },
}))

import {
  TurnProvisionError,
  __setProviderSecretStore,
  clampTtl,
  deleteProviderSecret,
  loadProviderSecret,
  normalizeTwilioIceServers,
  provisionIceServers,
  saveProviderSecret,
} from "./turn-provisioning"
import type { TurnProviderConfig } from "@cognia/agent-config-types"

// ---------------------------------------------------------------------------
// fetch double
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string
  init: RequestInit
}
function fakeFetch(status: number, body: unknown): { impl: typeof fetch; reqs: CapturedRequest[] } {
  const reqs: CapturedRequest[] = []
  const impl = (async (url: string, init: RequestInit) => {
    reqs.push({ url, init })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  }) as unknown as typeof fetch
  return { impl, reqs }
}

const NOW = 1_000_000

beforeEach(() => {
  mockIsTauri.mockReset().mockReturnValue(false)
  mockTransportCall.mockReset()
})

describe("clampTtl", () => {
  it("defaults to 86400 when unset", () => {
    expect(clampTtl(undefined)).toBe(86400)
  })
  it("clamps below the minimum up to 600", () => {
    expect(clampTtl(10)).toBe(600)
  })
  it("clamps above the maximum down to 86400", () => {
    expect(clampTtl(999999)).toBe(86400)
  })
  it("passes a valid ttl through", () => {
    expect(clampTtl(3600)).toBe(3600)
  })
})

describe("normalizeTwilioIceServers", () => {
  it("maps legacy `url` to `urls` and keeps credentials", () => {
    const out = normalizeTwilioIceServers([
      { url: "stun:global.stun.twilio.com:3478" },
      {
        url: "turn:global.turn.twilio.com:3478?transport=udp",
        username: "u",
        credential: "c",
      },
    ])
    expect(out).toEqual([
      { urls: "stun:global.stun.twilio.com:3478" },
      { urls: "turn:global.turn.twilio.com:3478?transport=udp", username: "u", credential: "c" },
    ])
  })
  it("accepts the plural `urls` form", () => {
    const out = normalizeTwilioIceServers([{ urls: "turn:x:3478", username: "u", credential: "c" }])
    expect(out).toEqual([{ urls: "turn:x:3478", username: "u", credential: "c" }])
  })
  it("drops entries without a url/urls", () => {
    const out = normalizeTwilioIceServers([{ username: "u" }, { url: "turn:x" }])
    expect(out).toEqual([{ urls: "turn:x" }])
  })
})

describe("provisionIceServers — Cloudflare Calls", () => {
  const provider: TurnProviderConfig = {
    kind: "cloudflare-calls",
    cloudflareKeyId: "key-123",
    ttlSeconds: 3600,
    secretRef: "kr:cf-secret",
  }

  it("POSTs to generate-ice-servers with a Bearer token and returns iceServers + expiresAt", async () => {
    const { impl, reqs } = fakeFetch(201, {
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478"] },
        { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "U", credential: "C" },
      ],
    })
    const result = await provisionIceServers(provider, {
      fetchImpl: impl,
      nowMs: () => NOW,
      loadSecret: async () => ({ apiToken: "tok-abc" }),
    })
    expect(reqs[0].url).toBe(
      "https://rtc.live.cloudflare.com/v1/turn/keys/key-123/credentials/generate-ice-servers"
    )
    expect((reqs[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok-abc")
    expect(reqs[0].init.body).toBe(JSON.stringify({ ttl: 3600 }))
    expect(result.iceServers).toHaveLength(2)
    expect(result.iceServers[1]).toEqual({
      urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
      username: "U",
      credential: "C",
    })
    expect(result.expiresAt).toBe(NOW + 3600 * 1000)
  })

  it("throws TurnProvisionError on a non-2xx response without leaking the token", async () => {
    const { impl } = fakeFetch(403, { error: "bad token tok-abc" })
    await expect(
      provisionIceServers(provider, {
        fetchImpl: impl,
        nowMs: () => NOW,
        loadSecret: async () => ({ apiToken: "tok-abc" }),
      })
    ).rejects.toMatchObject({ name: "TurnProvisionError", status: 403 })
    const err: Error = await provisionIceServers(provider, {
      fetchImpl: impl,
      nowMs: () => NOW,
      loadSecret: async () => ({ apiToken: "tok-abc" }),
    }).then(
      () => new Error("expected rejection"),
      (e: unknown) => e as Error
    )
    expect(err.message).not.toContain("tok-abc")
  })
})

describe("provisionIceServers — Twilio", () => {
  const provider: TurnProviderConfig = {
    kind: "twilio",
    twilioAccountSid: "ACxxxx",
    secretRef: "kr:tw-secret",
  }

  it("POSTs to Tokens.json with Basic auth and derives expiresAt from the response ttl", async () => {
    const { impl, reqs } = fakeFetch(201, {
      ttl: "3600",
      ice_servers: [
        { url: "stun:global.stun.twilio.com:3478" },
        { url: "turn:global.turn.twilio.com:3478?transport=udp", username: "u", credential: "c" },
      ],
    })
    const result = await provisionIceServers(provider, {
      fetchImpl: impl,
      nowMs: () => NOW,
      loadSecret: async () => ({ authToken: "auth-xyz" }),
    })
    expect(reqs[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACxxxx/Tokens.json")
    expect((reqs[0].init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${btoa("ACxxxx:auth-xyz")}`
    )
    expect(result.iceServers).toEqual([
      { urls: "stun:global.stun.twilio.com:3478" },
      { urls: "turn:global.turn.twilio.com:3478?transport=udp", username: "u", credential: "c" },
    ])
    expect(result.expiresAt).toBe(NOW + 3600 * 1000)
  })
})

describe("provisionIceServers — guards", () => {
  it("throws missing-secret when no secretRef is set, without fetching", async () => {
    const { impl, reqs } = fakeFetch(201, {})
    await expect(
      provisionIceServers({ kind: "cloudflare-calls", cloudflareKeyId: "k" }, { fetchImpl: impl })
    ).rejects.toMatchObject({ name: "TurnProvisionError", reason: "missing-secret" })
    expect(reqs).toHaveLength(0)
  })

  it("uses an explicitly injected inline secret before it is saved in a browser shell", async () => {
    const { impl, reqs } = fakeFetch(201, { iceServers: [] })
    const loadSecret = jest.fn(async () => ({ apiToken: "fresh-token" }))

    await provisionIceServers(
      { kind: "cloudflare-calls", cloudflareKeyId: "key-1" },
      { fetchImpl: impl, loadSecret }
    )

    expect(loadSecret).toHaveBeenCalledWith("__inline__")
    expect(reqs).toHaveLength(1)
    expect((reqs[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer fresh-token"
    )
  })

  it("throws missing-secret when the keyring entry is gone", async () => {
    const { impl } = fakeFetch(201, {})
    await expect(
      provisionIceServers(
        { kind: "cloudflare-calls", cloudflareKeyId: "k", secretRef: "kr:gone" },
        { fetchImpl: impl, loadSecret: async () => null }
      )
    ).rejects.toMatchObject({ reason: "missing-secret" })
  })

  it("throws for kind 'none'", async () => {
    await expect(
      provisionIceServers({ kind: "none" }, { loadSecret: async () => ({ apiToken: "t" }) })
    ).rejects.toBeInstanceOf(TurnProvisionError)
  })
})

describe("provisionIceServers — Tauri native path", () => {
  it("uses the saved key id without loading the secret into the renderer", async () => {
    mockIsTauri.mockReturnValue(true)
    mockTransportCall.mockResolvedValue({
      iceServers: [{ urls: "turn:native.example:3478", username: "u", credential: "c" }],
      expiresAtMs: 123_000,
    })
    const loadSecret = jest.fn()

    const result = await provisionIceServers(
      {
        kind: "cloudflare-calls",
        cloudflareKeyId: "cf-key",
        secretRef: "kr:saved-provider-token",
        ttlSeconds: 3_600,
      },
      { loadSecret }
    )

    expect(loadSecret).not.toHaveBeenCalled()
    expect(mockTransportCall).toHaveBeenCalledWith("turn_provision", {
      input: {
        kind: "cloudflare-calls",
        cloudflareKeyId: "cf-key",
        twilioAccountSid: undefined,
        ttlSeconds: 3_600,
        secretKeyId: "saved-provider-token",
        inlineToken: undefined,
      },
    })
    expect(result).toEqual({
      iceServers: [{ urls: "turn:native.example:3478", username: "u", credential: "c" }],
      expiresAt: 123_000,
    })
  })

  it("passes a freshly typed token inline before it is saved", async () => {
    mockIsTauri.mockReturnValue(true)
    mockTransportCall.mockResolvedValue({ iceServers: [], expiresAtMs: 456_000 })

    await provisionIceServers(
      { kind: "twilio", twilioAccountSid: "AC123" },
      { loadSecret: async () => ({ authToken: "fresh-auth-token" }) }
    )

    expect(mockTransportCall).toHaveBeenCalledWith(
      "turn_provision",
      expect.objectContaining({
        input: expect.objectContaining({
          kind: "twilio",
          secretKeyId: undefined,
          inlineToken: "fresh-auth-token",
        }),
      })
    )
  })

  it("normalizes native command failures into TurnProvisionError", async () => {
    mockIsTauri.mockReturnValue(true)
    mockTransportCall.mockRejectedValue(
      new Error("turn provisioning failed: twilio-http-error (status 403)")
    )

    await expect(
      provisionIceServers({ kind: "twilio", twilioAccountSid: "AC123", secretRef: "kr:saved" }, {})
    ).rejects.toMatchObject({
      name: "TurnProvisionError",
      reason: "twilio-http-error (status 403)",
    })
  })
})

describe("provider secret store", () => {
  class FakeStore {
    map = new Map<string, string>()
    async save(k: string, v: string) {
      this.map.set(k, v)
    }
    async load(k: string) {
      return this.map.has(k) ? this.map.get(k)! : null
    }
    async delete(k: string) {
      this.map.delete(k)
    }
  }
  let store: FakeStore
  beforeEach(() => {
    store = new FakeStore()
    __setProviderSecretStore(store)
  })
  afterAll(() => __setProviderSecretStore(null))

  it("round-trips a Cloudflare secret as JSON", async () => {
    await saveProviderSecret("k1", { apiToken: "tok" })
    expect(await loadProviderSecret("k1")).toEqual({ apiToken: "tok" })
  })

  it("round-trips a Twilio secret", async () => {
    await saveProviderSecret("k2", { authToken: "auth" })
    expect(await loadProviderSecret("k2")).toEqual({ authToken: "auth" })
  })

  it("returns null for an absent / malformed entry", async () => {
    expect(await loadProviderSecret("missing")).toBeNull()
    store.map.set("bad", "{not json")
    expect(await loadProviderSecret("bad")).toBeNull()
  })

  it("delete removes the entry", async () => {
    await saveProviderSecret("k1", { apiToken: "tok" })
    await deleteProviderSecret("k1")
    expect(await loadProviderSecret("k1")).toBeNull()
  })
})
