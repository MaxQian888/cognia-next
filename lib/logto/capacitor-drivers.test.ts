/** @jest-environment jsdom */

import {
  LogtoSignInCancelled,
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
    const drivers = createLogtoCapacitorDrivers({ runOAuth, appHandoff })
    await drivers.openUrl(feishuAuthorize)
    await drivers.waitForCode({ state: "st", redirectUri: "x" })
    expect(appHandoff).toHaveBeenCalledWith(feishuAuthorize)
    expect(runOAuth).toHaveBeenCalledWith(expect.objectContaining({ appHandoff: handoff }))
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

  it("treats this app's resume as the return", async () => {
    const remove = jest.fn()
    nativeApp.subscribeResume.mockResolvedValue(remove)
    const handler = jest.fn()
    await expect(providerAppHandoff(feishuAuthorize)!.onReturn(handler)).resolves.toBe(remove)
    expect(nativeApp.subscribeResume).toHaveBeenCalledWith(handler)
  })
})
