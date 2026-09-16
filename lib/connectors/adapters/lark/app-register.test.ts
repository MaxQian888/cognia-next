/**
 * Tests for `app-register.ts` — the in-house port of the official Node SDK's
 * `registerApp()` device-authorization flow. The `request` seam is a stub so
 * no network happens; `sleep`/`now` are injected for deterministic polling.
 */
import {
  LARK_ACCOUNTS_BASE_FEISHU,
  LARK_ACCOUNTS_BASE_LARK,
  LarkAppRegistrationError,
  beginLarkAppRegistration,
  buildLarkRegistrationConfirmUrl,
  encodeLarkAppAddons,
  registerLarkApp,
} from "./app-register"
import type { TauriHttpRequest, TauriHttpResponse } from "@/lib/connectors/tauri/commands"

jest.mock("fflate", () => ({
  gzipSync: jest.fn((data: Uint8Array) => {
    // Minimal deterministic stand-in — tests only need to see the payload
    // round-trip, so prefix the raw JSON rather than real gzip bytes.
    const prefix = new TextEncoder().encode("GZIP:")
    const out = new Uint8Array(prefix.length + data.length)
    out.set(prefix)
    out.set(data, prefix.length)
    return out
  }),
  strToU8: (s: string) => new TextEncoder().encode(s),
}))

function response(body: unknown, status = 200): TauriHttpResponse {
  return { status, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }
}

function beginBody(overrides: Record<string, unknown> = {}) {
  return {
    device_code: "dev-123",
    verification_uri_complete: "https://accounts.feishu.cn/oauth/v1/device?user_code=AB-CD",
    verification_uri: "https://accounts.feishu.cn/oauth/v1/device",
    user_code: "AB-CD",
    interval: 1,
    expires_in: 600,
    ...overrides,
  }
}

type RecordedRequest = TauriHttpRequest

function makeRequest(
  handler: (req: RecordedRequest) => TauriHttpResponse | Promise<TauriHttpResponse>
) {
  const calls: RecordedRequest[] = []
  const request = jest.fn(async (req: RecordedRequest) => {
    calls.push(req)
    return handler(req)
  })
  return { request, calls }
}

const noSleep = jest.fn(async () => undefined)

describe("beginLarkAppRegistration", () => {
  it("posts the begin form to the Feishu accounts host", async () => {
    const { request, calls } = makeRequest(() => response(beginBody()))
    const begun = await beginLarkAppRegistration({ request })

    expect(calls).toHaveLength(1)
    const req = calls[0]
    expect(req.url).toBe(`${LARK_ACCOUNTS_BASE_FEISHU}/oauth/v1/app/registration`)
    expect(req.method).toBe("POST")
    expect(req.headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded")
    const params = new URLSearchParams(req.body)
    expect(params.get("action")).toBe("begin")
    expect(params.get("archetype")).toBe("PersonalAgent")
    expect(params.get("auth_method")).toBe("client_secret")
    expect(params.get("request_user_info")).toBe("open_id")
    expect(begun.deviceCode).toBe("dev-123")
    expect(begun.intervalSec).toBe(1)
    expect(begun.expiresInSec).toBe(600)
  })

  it("throws when the begin response is missing device_code", async () => {
    const { request } = makeRequest(() =>
      response({ verification_uri_complete: "https://x.test/confirm" })
    )
    await expect(beginLarkAppRegistration({ request })).rejects.toMatchObject({
      code: "invalid_response",
    })
  })

  it("propagates a protocol error body", async () => {
    const { request } = makeRequest(() =>
      response({ error: "invalid_request", error_description: "bad archetype" }, 400)
    )
    await expect(beginLarkAppRegistration({ request })).rejects.toMatchObject({
      code: "invalid_request",
    })
  })

  it("wraps transport failure as begin_failed", async () => {
    const request = jest.fn(async () => {
      throw new Error("socket hangup")
    })
    await expect(beginLarkAppRegistration({ request })).rejects.toMatchObject({
      code: "begin_failed",
    })
  })

  it("rejects a non-JSON begin body", async () => {
    const { request } = makeRequest(() => response("<html>oops</html>"))
    await expect(beginLarkAppRegistration({ request })).rejects.toMatchObject({
      code: "invalid_response",
    })
  })
})

describe("encodeLarkAppAddons", () => {
  const decode = (encoded: string): Record<string, unknown> => {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/")
    const bin = atob(b64)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    const prefix = new TextDecoder().decode(bytes.slice(0, 5))
    expect(prefix).toBe("GZIP:")
    return JSON.parse(new TextDecoder().decode(bytes.slice(5)))
  }

  it("encodes the canonical addons shape", () => {
    const encoded = encodeLarkAppAddons({
      preset: false,
      scopes: { tenant: ["im:message:send_as_bot"] },
      events: { items: { tenant: ["im.message.receive_v1"] } },
    })
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decode(encoded)).toEqual({
      preset: false,
      scopes: { tenant: ["im:message:send_as_bot"] },
      events: { items: { tenant: ["im.message.receive_v1"] } },
    })
  })

  it("rejects unknown keys so the confirm page cannot silently drop a typo", () => {
    expect(() => encodeLarkAppAddons({ security: {} } as never)).toThrow(LarkAppRegistrationError)
    expect(() => encodeLarkAppAddons({ security: {} } as never)).toThrow(/not allowed/)
  })

  it("rejects an empty addons payload unless preset:false is the payload", () => {
    expect(() => encodeLarkAppAddons({})).toThrow(/at least one/)
    expect(() => encodeLarkAppAddons({ preset: false })).not.toThrow()
  })

  it("rejects non-string scope entries and non-boolean preset", () => {
    expect(() => encodeLarkAppAddons({ scopes: { tenant: [""] } })).toThrow(/non-empty string/)
    expect(() => encodeLarkAppAddons({ preset: "no" as never })).toThrow(/boolean/)
  })
})

describe("buildLarkRegistrationConfirmUrl", () => {
  const base = "https://accounts.feishu.cn/oauth/v1/device?user_code=AB-CD"

  it("appends tracking, preset and createOnly params", () => {
    const url = buildLarkRegistrationConfirmUrl({
      verificationUriComplete: base,
      source: "settings",
      createOnly: true,
      appPreset: { name: "My Bot", desc: "Does things", avatar: "https://cdn.example.com/a.webp" },
    })
    const u = new URL(url)
    expect(u.searchParams.get("user_code")).toBe("AB-CD")
    expect(u.searchParams.get("from")).toBe("cognia")
    expect(u.searchParams.get("source")).toBe("cognia/settings")
    expect(u.searchParams.get("tp")).toBe("cognia")
    expect(u.searchParams.get("name")).toBe("My Bot")
    expect(u.searchParams.get("desc")).toBe("Does things")
    expect(u.searchParams.getAll("avatar")).toEqual(["https://cdn.example.com/a.webp"])
    expect(u.searchParams.get("createOnly")).toBe("true")
  })

  it("repeats the avatar param for a list and caps at six", () => {
    const avatars = ["https://a/1.png", "https://a/2.png"]
    const url = buildLarkRegistrationConfirmUrl({
      verificationUriComplete: base,
      appPreset: { avatar: avatars },
    })
    expect(new URL(url).searchParams.getAll("avatar")).toEqual(avatars)

    expect(() =>
      buildLarkRegistrationConfirmUrl({
        verificationUriComplete: base,
        appPreset: { avatar: Array.from({ length: 7 }, (_, i) => `https://a/${i}.png`) },
      })
    ).toThrow(/at most 6/)
  })

  it("rejects non-http(s) avatars — never smuggle a data: URL or image_key", () => {
    for (const bad of ["data:image/png;base64,AAA", "img_v2_xkey", "ftp://a/b.png"]) {
      expect(() =>
        buildLarkRegistrationConfirmUrl({
          verificationUriComplete: base,
          appPreset: { avatar: bad },
        })
      ).toThrow(/publicly reachable/)
    }
  })

  it("encodes addons into the URL", () => {
    const url = buildLarkRegistrationConfirmUrl({
      verificationUriComplete: base,
      addons: { preset: false, scopes: { tenant: ["im:message"] } },
    })
    expect(new URL(url).searchParams.get("addons")).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("carries clientID for the update flow", () => {
    const url = buildLarkRegistrationConfirmUrl({
      verificationUriComplete: base,
      appId: "cli_existing",
    })
    expect(new URL(url).searchParams.get("clientID")).toBe("cli_existing")
    expect(new URL(url).searchParams.get("createOnly")).toBeNull()
  })
})

describe("registerLarkApp", () => {
  const options = { createOnly: true }

  it("begins, emits the confirm URL, polls to success", async () => {
    const { request, calls } = makeRequest((req) => {
      const params = new URLSearchParams(req.body)
      if (params.get("action") === "begin") return response(beginBody())
      if (params.get("action") === "poll") {
        return response({ client_id: "cli_new", client_secret: "secret" })
      }
      throw new Error("unexpected action")
    })
    const urls: string[] = []
    const statuses: string[] = []
    const result = await registerLarkApp(
      {
        ...options,
        onVerificationUrl: (u) => urls.push(u),
        onStatusChange: (s) => statuses.push(s),
      },
      { request, sleep: noSleep }
    )
    expect(result).toEqual({ clientId: "cli_new", clientSecret: "secret", userInfo: undefined })
    expect(urls[0]).toContain("user_code=AB-CD")
    expect(urls[0]).toContain("createOnly=true")
    expect(statuses).toContain("begin")
    expect(statuses).toContain("awaiting_user")
    expect(calls).toHaveLength(2)
    const poll = new URLSearchParams(calls[1].body)
    expect(poll.get("action")).toBe("poll")
    expect(poll.get("device_code")).toBe("dev-123")
  })

  it("keeps polling through authorization_pending", async () => {
    let polls = 0
    const { request } = makeRequest((req) => {
      const params = new URLSearchParams(req.body)
      if (params.get("action") === "begin") return response(beginBody())
      polls += 1
      return polls < 3
        ? response({ error: "authorization_pending" })
        : response({ client_id: "cli_ok", client_secret: "s" })
    })
    const result = await registerLarkApp(options, { request, sleep: noSleep })
    expect(result.clientId).toBe("cli_ok")
    expect(polls).toBe(3)
  })

  it("slow_down adds five seconds to the interval", async () => {
    let polls = 0
    const { request } = makeRequest((req) => {
      const params = new URLSearchParams(req.body)
      if (params.get("action") === "begin") return response(beginBody({ interval: 2 }))
      polls += 1
      return polls === 1
        ? response({ error: "slow_down" })
        : response({ client_id: "cli_x", client_secret: "s" })
    })
    const sleeps: number[] = []
    const sleep = jest.fn(async (ms: number) => {
      sleeps.push(ms)
    })
    await registerLarkApp(options, { request, sleep })
    // interval 2s → slow_down → 7s for the next wait
    expect(sleeps).toEqual([2000, 7000])
  })

  it("access_denied is terminal", async () => {
    const { request } = makeRequest((req) => {
      const params = new URLSearchParams(req.body)
      if (params.get("action") === "begin") return response(beginBody())
      return response({ error: "access_denied", error_description: "user said no" })
    })
    await expect(registerLarkApp(options, { request, sleep: noSleep })).rejects.toMatchObject({
      code: "access_denied",
    })
  })

  it("expired_token from the endpoint is terminal", async () => {
    const { request } = makeRequest((req) => {
      const params = new URLSearchParams(req.body)
      if (params.get("action") === "begin") return response(beginBody())
      return response({ error: "expired_token" })
    })
    await expect(registerLarkApp(options, { request, sleep: noSleep })).rejects.toMatchObject({
      code: "expired_token",
    })
  })

  it("times out locally when expires_in elapses", async () => {
    let t = 0
    const { request } = makeRequest((req) => {
      const params = new URLSearchParams(req.body)
      if (params.get("action") === "begin") return response(beginBody({ expires_in: 3 }))
      return response({ error: "authorization_pending" })
    })
    const sleep = jest.fn(async (ms: number) => {
      t += ms
    })
    const now = () => t
    await expect(registerLarkApp(options, { request, sleep, now })).rejects.toMatchObject({
      code: "expired_token",
    })
  })

  it("aborts cleanly via AbortSignal before polling starts", async () => {
    const controller = new AbortController()
    controller.abort()
    const request = jest.fn()
    await expect(
      registerLarkApp({ signal: controller.signal }, { request, sleep: noSleep })
    ).rejects.toMatchObject({ code: "abort" })
    expect(request).not.toHaveBeenCalled()
  })

  it("aborts while waiting between polls", async () => {
    const controller = new AbortController()
    const { request } = makeRequest((req) => {
      const params = new URLSearchParams(req.body)
      if (params.get("action") === "begin") return response(beginBody())
      return response({ client_id: "cli_late", client_secret: "s" })
    })
    const sleep = jest.fn(async () => {
      controller.abort()
    })
    await expect(
      registerLarkApp({ signal: controller.signal }, { request, sleep })
    ).rejects.toMatchObject({ code: "abort" })
  })

  it("switches to the Lark accounts domain once on tenant_brand=lark", async () => {
    const pollUrls: string[] = []
    let larkPolls = 0
    const { request } = makeRequest((req) => {
      const params = new URLSearchParams(req.body)
      if (params.get("action") === "begin") return response(beginBody())
      pollUrls.push(req.url)
      if (req.url.startsWith(LARK_ACCOUNTS_BASE_LARK)) {
        larkPolls += 1
        return response({
          client_id: "cli_lark",
          client_secret: "s",
          user_info: { tenant_brand: "lark" },
        })
      }
      return response({
        client_id: "cli_partial",
        client_secret: "s",
        user_info: { tenant_brand: "lark" },
      })
    })
    const result = await registerLarkApp(options, { request, sleep: noSleep })
    expect(result.clientId).toBe("cli_lark")
    expect(larkPolls).toBe(1)
    expect(pollUrls[0]).toContain("accounts.feishu.cn")
    expect(pollUrls[1]).toContain("accounts.larksuite.com")
    // switched once — stays on lark domain thereafter
    expect(pollUrls.every((u, i) => i === 0 || u.startsWith(LARK_ACCOUNTS_BASE_LARK))).toBe(true)
  })

  it("unknown poll errors are terminal", async () => {
    const { request } = makeRequest((req) => {
      const params = new URLSearchParams(req.body)
      if (params.get("action") === "begin") return response(beginBody())
      return response({ error: "temporarily_unavailable", error_description: "try later" })
    })
    await expect(registerLarkApp(options, { request, sleep: noSleep })).rejects.toMatchObject({
      code: "temporarily_unavailable",
    })
  })

  it("a mid-flow poll carrying only user_info keeps the loop alive", async () => {
    let polls = 0
    const { request } = makeRequest((req) => {
      const params = new URLSearchParams(req.body)
      if (params.get("action") === "begin") return response(beginBody())
      polls += 1
      return polls === 1
        ? response({ user_info: { open_id: "ou_x" } })
        : response({ client_id: "cli_done", client_secret: "s" })
    })
    const result = await registerLarkApp(options, { request, sleep: noSleep })
    expect(result.clientId).toBe("cli_done")
    expect(polls).toBe(2)
  })
})
