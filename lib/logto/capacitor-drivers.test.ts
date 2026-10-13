/** @jest-environment jsdom */

import {
  APP_RETURN_CLAIM_PATH,
  LogtoSignInCancelled,
  claimAppReturn,
  createLogtoCapacitorDrivers,
  providerAppHandoff,
} from "./capacitor-drivers"

import type { CallbackOutcome, RunOAuthOptions } from "@/lib/oauth/mobile-flow"

jest.mock("@/lib/capacitor/app-handoff", () => ({
  isAppHandoffAvailable: jest.fn(),
  openInApp: jest.fn(),
}))
jest.mock("@/lib/capacitor/app", () => ({ subscribeResume: jest.fn() }))

const nativeHandoff = jest.requireMock("@/lib/capacitor/app-handoff")
const nativeApp = jest.requireMock("@/lib/capacitor/app")
const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json" },
  })
const feishuAuthorize =
  "https://id.cognia.cn/api/auth/oauth2/authorize?client_id=cognia-app&state=st&provider=feishu"

function driversWith(outcome: CallbackOutcome) {
  const runOAuth = jest.fn(async (_opts: RunOAuthOptions) => outcome)
  const drivers = createLogtoCapacitorDrivers({ runOAuth })
  return { drivers, runOAuth }
}

const route = (overrides: Record<string, unknown>) => ({
  kind: "logto_callback" as const,
  code: "c",
  state: "st",
  error: null,
  raw: "cognia://logto/callback",
  ...overrides,
})

describe("createLogtoCapacitorDrivers", () => {
  it("opens the authorize URL through the in-app browser flow and returns the code", async () => {
    const { drivers, runOAuth } = driversWith({
      kind: "ok",
      result: { code: "code-1", state: "st", via: "deeplink" },
    })
    await drivers.openUrl("https://logto.example/oidc/auth?state=st")
    await expect(
      drivers.waitForCode({ state: "st", redirectUri: "cognia://logto/callback" })
    ).resolves.toEqual({ code: "code-1", state: "st" })
    expect(runOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizeUrl: "https://logto.example/oidc/auth?state=st",
        provider: "logto",
      })
    )
  })

  it("accepts only the Logto callback for its own state", async () => {
    const { drivers, runOAuth } = driversWith({ kind: "cancelled" })
    await drivers.openUrl("https://logto.example/oidc/auth")
    await drivers.waitForCode({ state: "st", redirectUri: "x" }).catch(() => undefined)
    const accept = (runOAuth.mock.calls[0]![0] as RunOAuthOptions).accept!
    expect(
      accept({ kind: "oauth_callback", provider: "claude", code: "c", state: "st", raw: "" })
    ).toBeNull()
    expect(accept(route({ state: "other" }))).toBe("mismatch")
    expect(accept(route({ code: null }))).toBe("mismatch")
    expect(accept(route({ error: "access_denied" }))).toEqual({ error: "access_denied" })
    expect(accept(route({}))).toEqual({ code: "c", state: "st" })
  })

  it("maps the flow outcomes to the errors the gate understands", async () => {
    for (const [outcome, expected] of [
      [{ kind: "mismatch" }, "Logto callback state mismatch"],
      [{ kind: "error", error: "access_denied" }, "Logto authorization failed: access_denied"],
    ] as const) {
      const { drivers } = driversWith(outcome as CallbackOutcome)
      await drivers.openUrl("https://logto.example/oidc/auth")
      await expect(drivers.waitForCode({ state: "st", redirectUri: "x" })).rejects.toThrow(expected)
    }
    for (const outcome of [{ kind: "cancelled" }, { kind: "timeout" }] as const) {
      const { drivers } = driversWith(outcome as CallbackOutcome)
      await drivers.openUrl("https://logto.example/oidc/auth")
      await expect(drivers.waitForCode({ state: "st", redirectUri: "x" })).rejects.toBeInstanceOf(
        LogtoSignInCancelled
      )
    }
  })

  it("hands a request naming the provider's app to that app", async () => {
    const handoff = { open: jest.fn(), onReturn: jest.fn() }
    const appHandoff = jest.fn(() => handoff)
    const runOAuth = jest.fn(async (_opts: RunOAuthOptions) => ({
      kind: "ok" as const,
      result: { code: "c", state: "st", via: "deeplink" as const },
    }))
    const fetchImpl = jest.fn() as unknown as typeof fetch
    const drivers = createLogtoCapacitorDrivers({ runOAuth, appHandoff, fetchImpl })
    await drivers.openUrl(feishuAuthorize)
    await drivers.waitForCode({ state: "st", redirectUri: "x", codeVerifier: "v" })
    expect(appHandoff).toHaveBeenCalledWith(feishuAuthorize, {
      state: "st",
      codeVerifier: "v",
      fetchImpl,
    })
    expect(runOAuth).toHaveBeenCalledWith(expect.objectContaining({ appHandoff: handoff }))

    // Without a verifier there is nothing to claim with.
    await drivers.openUrl(feishuAuthorize)
    await drivers.waitForCode({ state: "st", redirectUri: "x" })
    expect(appHandoff).toHaveBeenLastCalledWith(feishuAuthorize, undefined)
  })

  it("refuses to wait for a URL that was never opened", async () => {
    const { drivers } = driversWith({ kind: "cancelled" })
    await expect(drivers.waitForCode({ state: "st", redirectUri: "x" })).rejects.toThrow(
      "never opened"
    )
  })
})

describe("providerAppHandoff", () => {
  beforeEach(() => jest.clearAllMocks())

  it("has nothing to hand off for a request without a provider app", () => {
    expect(
      providerAppHandoff("https://id.cognia.cn/api/auth/oauth2/authorize?provider=github")
    ).toBeUndefined()
  })

  it("opens the Feishu Applink only once the Feishu app answers the probe", async () => {
    const handoff = providerAppHandoff(feishuAuthorize)!
    nativeHandoff.isAppHandoffAvailable.mockResolvedValue(true)
    nativeHandoff.openInApp.mockResolvedValue(true)
    await expect(handoff.open()).resolves.toBe(true)
    const [target, link] = nativeHandoff.openInApp.mock.calls[0]
    expect(target).toBe("feishu")
    expect(new URL(link).searchParams.get("url")).toBe(feishuAuthorize)

    nativeHandoff.openInApp.mockClear()
    nativeHandoff.isAppHandoffAvailable.mockResolvedValue(false)
    await expect(handoff.open()).resolves.toBe(false)
    expect(nativeHandoff.openInApp).not.toHaveBeenCalled()
  })

  it("recovers through the issuer's claim only when it can prove the request", async () => {
    expect(providerAppHandoff(feishuAuthorize)!.recover).toBeUndefined()
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ code: "kept", state: "st" })
    ) as unknown as typeof fetch
    const handoff = providerAppHandoff(feishuAuthorize, {
      state: "st",
      codeVerifier: "v",
      fetchImpl,
    })!
    await expect(handoff.recover!()).resolves.toEqual({ code: "kept", state: "st" })
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://id.cognia.cn${APP_RETURN_CLAIM_PATH}`,
      expect.objectContaining({ method: "POST" })
    )
  })

  it("treats this app's resume as the return", async () => {
    const remove = jest.fn()
    nativeApp.subscribeResume.mockResolvedValue(remove)
    const handler = jest.fn()
    await expect(providerAppHandoff(feishuAuthorize)!.onReturn(handler)).resolves.toBe(remove)
    expect(nativeApp.subscribeResume).toHaveBeenCalledWith(handler)
  })
})

describe("claimAppReturn", () => {
  const pickup = (response: Response | Promise<never>) => {
    const fetchImpl = jest.fn(async () => response) as unknown as jest.Mock
    return {
      fetchImpl,
      pickup: { state: "st", codeVerifier: "verifier", fetchImpl: fetchImpl as typeof fetch },
    }
  }

  it("posts the state and verifier to the issuer's claim and returns the code", async () => {
    const { fetchImpl, pickup: claim } = pickup(jsonResponse({ code: "kept", state: "st" }))
    await expect(claimAppReturn(feishuAuthorize, claim)).resolves.toEqual({
      code: "kept",
      state: "st",
    })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("https://id.cognia.cn/api/app-return/claim")
    expect(init.headers).toMatchObject({ "content-type": "application/json" })
    expect(JSON.parse(init.body)).toEqual({ state: "st", code_verifier: "verifier" })
  })

  it("has nothing for a refused claim or an answer that is not this request's", async () => {
    for (const response of [
      jsonResponse({ error: "not_found" }, { status: 404 }),
      jsonResponse({ error: "x" }, { status: 503 }),
      jsonResponse({ code: "kept", state: "someone-else" }),
      jsonResponse({ code: "", state: "st" }),
      jsonResponse({ state: "st" }),
      new Response("not json"),
    ]) {
      await expect(claimAppReturn(feishuAuthorize, pickup(response).pickup)).resolves.toBeNull()
    }
  })

  it("lets a network failure surface to the flow, which treats it as nothing kept", async () => {
    const { pickup: claim } = pickup(Promise.reject(new Error("offline")))
    await expect(claimAppReturn(feishuAuthorize, claim)).rejects.toThrow("offline")
  })
})
