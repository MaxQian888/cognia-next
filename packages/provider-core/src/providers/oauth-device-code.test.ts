/** @jest-environment jsdom */
import { getAllProviders, setDynamicProviderRegistry } from "@cognia/provider-types"

import {
  MAX_DEVICE_POLL_ATTEMPTS,
  MIN_DEVICE_POLL_INTERVAL_MS,
  SLOW_DOWN_INCREMENT_MS,
  pollDeviceCodeOnce,
  runDeviceCodeLogin,
  startDeviceCodeLogin,
  supportsDeviceCodeLogin,
  type DeviceCodeGrant,
  type DeviceCodePoll,
} from "./oauth-device-code"

const fetchMock = jest.fn()

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

const TEST_PROVIDER = {
  id: "test-device",
  name: "Test Device",
  models: [],
  defaultModel: "m",
  supportsOAuth: true,
  oauthConfig: {
    authorizationUrl: "https://example.test/authorize",
    tokenUrl: "https://example.test/token",
    clientId: "client-123",
    callbackPath: "/cb",
    deviceCode: {
      deviceCodeUrl: "https://example.test/device/code",
      scope: "read:user",
    },
  },
} as never

beforeAll(() => {
  setDynamicProviderRegistry(() => ({ "test-device": TEST_PROVIDER }))
})

afterAll(() => {
  setDynamicProviderRegistry(() => ({}))
})

beforeEach(() => {
  fetchMock.mockReset()
  global.fetch = fetchMock as unknown as typeof fetch
})

const grant = (over: Partial<DeviceCodeGrant> = {}): DeviceCodeGrant => ({
  deviceCode: "dc-1",
  userCode: "ABCD-EFGH",
  verificationUri: "https://example.test/activate",
  intervalSeconds: 5,
  expiresInSeconds: 900,
  ...over,
})

describe("supportsDeviceCodeLogin", () => {
  it("is true only for a provider that declares the flow", () => {
    expect(supportsDeviceCodeLogin("test-device")).toBe(true)
    expect(supportsDeviceCodeLogin("openrouter")).toBe(false)
    expect(supportsDeviceCodeLogin("nope")).toBe(false)
  })
})

describe("startDeviceCodeLogin", () => {
  it("returns the code, the verification page, and the provider's cadence", async () => {
    fetchMock.mockResolvedValueOnce(
      response({
        device_code: "dc-1",
        user_code: "WXYZ-1234",
        verification_uri: "https://example.test/activate",
        interval: 7,
        expires_in: 600,
      })
    )
    await expect(startDeviceCodeLogin("test-device")).resolves.toEqual({
      deviceCode: "dc-1",
      userCode: "WXYZ-1234",
      verificationUri: "https://example.test/activate",
      verificationUriComplete: undefined,
      intervalSeconds: 7,
      expiresInSeconds: 600,
    })
  })

  it("sends the client id and scope the provider declared", async () => {
    fetchMock.mockResolvedValueOnce(
      response({ device_code: "dc", user_code: "U", verification_uri: "https://v" })
    )
    await startDeviceCodeLogin("test-device")
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://example.test/device/code")
    expect(JSON.parse(init.body as string)).toMatchObject({
      client_id: "client-123",
      scope: "read:user",
    })
  })

  it("falls back to the RFC defaults when the provider states no timings", async () => {
    fetchMock.mockResolvedValueOnce(
      response({ device_code: "dc", user_code: "U", verification_uri: "https://v" })
    )
    const started = await startDeviceCodeLogin("test-device")
    expect(started?.intervalSeconds).toBe(5)
    expect(started?.expiresInSeconds).toBe(900)
  })

  it("returns null for a provider without the flow", async () => {
    await expect(startDeviceCodeLogin("openrouter")).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("throws with the provider's message on a rejected request", async () => {
    fetchMock.mockResolvedValueOnce(response({ error_description: "app suspended" }, 400))
    await expect(startDeviceCodeLogin("test-device")).rejects.toThrow("app suspended")
  })
})

describe("pollDeviceCodeOnce", () => {
  it("reads RFC 8628 pending and slow_down out of the body, not the status", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: "authorization_pending" }, 400))
    await expect(pollDeviceCodeOnce("test-device", "dc")).resolves.toEqual({ status: "pending" })

    fetchMock.mockResolvedValueOnce(response({ error: "slow_down" }, 400))
    await expect(pollDeviceCodeOnce("test-device", "dc")).resolves.toEqual({ status: "slow_down" })
  })

  it("surfaces a real denial as a failure", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: "access_denied" }, 400))
    await expect(pollDeviceCodeOnce("test-device", "dc")).resolves.toMatchObject({
      status: "failed",
    })
  })

  it("returns the credential once the user finishes", async () => {
    fetchMock.mockResolvedValueOnce(
      response({ access_token: "gho_abc", refresh_token: "rt-1", expires_in: 3600 })
    )
    const result = await pollDeviceCodeOnce("test-device", "dc")
    expect(result.status).toBe("complete")
    if (result.status === "complete") {
      expect(result.credential.apiKey).toBe("gho_abc")
      expect(result.credential.refreshToken).toBe("rt-1")
      expect(result.credential.expiresAt).toBeGreaterThan(Date.now())
    }
  })

  it("treats a dropped connection as pending, not as the user declining", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"))
    await expect(pollDeviceCodeOnce("test-device", "dc")).resolves.toEqual({ status: "pending" })
  })
})

describe("runDeviceCodeLogin", () => {
  const clock = (start = 0) => {
    let t = start
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms
      },
      advance: (ms: number) => {
        t += ms
      },
    }
  }

  it("returns the credential as soon as the user finishes", async () => {
    const c = clock()
    const poll = jest
      .fn<Promise<DeviceCodePoll>, [string, string]>()
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "complete", credential: { apiKey: "k" } })

    const outcome = await runDeviceCodeLogin("test-device", {
      grant: grant(),
      poll,
      now: c.now,
      sleep: c.sleep,
    })
    expect(outcome).toEqual({ status: "complete", credential: { apiKey: "k" } })
    expect(poll).toHaveBeenCalledTimes(2)
  })

  it("honors the provider's interval between polls", async () => {
    const c = clock()
    const gaps: number[] = []
    let last = 0
    const poll = jest.fn(async () => {
      gaps.push(c.now() - last)
      last = c.now()
      return { status: "pending" } as DeviceCodePoll
    })
    await runDeviceCodeLogin("test-device", {
      grant: grant({ intervalSeconds: 5, expiresInSeconds: 20 }),
      poll,
      now: c.now,
      sleep: c.sleep,
    })
    expect(gaps.slice(1)).toEqual([5_000, 5_000, 5_000])
  })

  it("widens the interval for the rest of the flow after slow_down", async () => {
    // The RFC's instruction is to slow down, not to retry once and go back to
    // the old cadence, which is what the provider objected to.
    const c = clock()
    const stamps: number[] = []
    const poll = jest.fn(async () => {
      stamps.push(c.now())
      return { status: stamps.length === 1 ? "slow_down" : "pending" } as DeviceCodePoll
    })
    await runDeviceCodeLogin("test-device", {
      grant: grant({ intervalSeconds: 5, expiresInSeconds: 40 }),
      poll,
      now: c.now,
      sleep: c.sleep,
    })
    const widened = 5_000 + SLOW_DOWN_INCREMENT_MS
    expect(stamps[1] - stamps[0]).toBe(widened)
    expect(stamps[2] - stamps[1]).toBe(widened)
  })

  it("floors a hostile interval so it cannot busy-loop", async () => {
    const c = clock()
    const stamps: number[] = []
    const poll = jest.fn(async () => {
      stamps.push(c.now())
      return { status: "pending" } as DeviceCodePoll
    })
    await runDeviceCodeLogin("test-device", {
      grant: grant({ intervalSeconds: 0.001, expiresInSeconds: 10 }),
      poll,
      now: c.now,
      sleep: c.sleep,
    })
    expect(stamps[1] - stamps[0]).toBe(MIN_DEVICE_POLL_INTERVAL_MS)
  })

  it("stops at the provider's expiry", async () => {
    const c = clock()
    const poll = jest.fn(async () => ({ status: "pending" }) as DeviceCodePoll)
    const outcome = await runDeviceCodeLogin("test-device", {
      grant: grant({ intervalSeconds: 5, expiresInSeconds: 12 }),
      poll,
      now: c.now,
      sleep: c.sleep,
    })
    expect(outcome).toEqual({ status: "expired" })
  })

  it("terminates a provider that answers pending forever", async () => {
    // The deadline normally ends the loop. The attempt cap is the backstop for
    // a provider that reports an absurd expiry.
    const poll = jest.fn(async () => ({ status: "pending" }) as DeviceCodePoll)
    const outcome = await runDeviceCodeLogin("test-device", {
      grant: grant({ intervalSeconds: 1, expiresInSeconds: 10 ** 9 }),
      poll,
      now: () => 0,
      sleep: async () => {},
    })
    expect(outcome).toEqual({ status: "expired" })
    expect(poll).toHaveBeenCalledTimes(MAX_DEVICE_POLL_ATTEMPTS)
  })

  it("stops immediately when the caller cancels", async () => {
    const controller = new AbortController()
    controller.abort()
    const poll = jest.fn(async () => ({ status: "pending" }) as DeviceCodePoll)
    await expect(
      runDeviceCodeLogin("test-device", {
        grant: grant(),
        poll,
        signal: controller.signal,
        now: () => 0,
        sleep: async () => {},
      })
    ).resolves.toEqual({ status: "cancelled" })
    expect(poll).not.toHaveBeenCalled()
  })

  it("reports a provider failure without throwing", async () => {
    const poll = jest.fn(
      async () => ({ status: "failed", message: "access_denied" }) as DeviceCodePoll
    )
    await expect(
      runDeviceCodeLogin("test-device", {
        grant: grant(),
        poll,
        now: () => 0,
        sleep: async () => {},
      })
    ).resolves.toEqual({ status: "failed", message: "access_denied" })
  })
})

describe("what currently declares this flow", () => {
  it("pins that no built-in provider does yet, so the gap stays deliberate", () => {
    // The engine is complete and exercised above, but nothing in the shipped
    // catalog uses it. Every provider that publishes a device-code login
    // (GitHub Copilot foremost) requires a registered OAuth app, and shipping
    // another project's client id would mean impersonating their application.
    // Activating this is one registered client id plus a `deviceCode` block on
    // that provider's catalog entry.
    //
    // This assertion exists so the gap is a recorded decision rather than an
    // oversight: the day a provider declares the flow, this test fails and
    // whoever added it is told to wire the UI too.
    const declaring = Object.values(getAllProviders())
      .filter((provider) => provider.oauthConfig?.deviceCode)
      .map((provider) => provider.id)
      .filter((id) => id !== "test-device")
    expect(declaring).toEqual([])
  })
})
