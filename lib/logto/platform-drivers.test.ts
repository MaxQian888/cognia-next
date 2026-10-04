/** @jest-environment jsdom */

jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn() }))
jest.mock("./web-popup", () => ({ createLogtoWebPopupDrivers: () => ({ flavour: "popup" }) }))
jest.mock("./capacitor-drivers", () => ({
  createLogtoCapacitorDrivers: () => ({ flavour: "capacitor" }),
}))

import { openUrl } from "@/lib/native/opener"

import { LOGTO_NATIVE_CALLBACK_URI, OIDC_NATIVE_CALLBACK_URI } from "./client"
import { publishLogtoDeepLinkCallback } from "./deep-link-callback"
import { platformSignInDrivers } from "./platform-drivers"

const callback = (state: string) => ({
  kind: "logto_callback" as const,
  code: "code-1",
  state,
  error: null,
  raw: `cn.cognia.app:/auth/callback?code=code-1&state=${state}`,
})

describe("platformSignInDrivers", () => {
  it("sends Capacitor to the in-app browser with the issuer's native callback", () => {
    const result = platformSignInDrivers({ issuerKind: "oidc", isCapacitor: () => true })
    expect(result).toEqual({
      drivers: { flavour: "capacitor" },
      redirectUri: OIDC_NATIVE_CALLBACK_URI,
      clientKind: "native",
    })
  })

  it("uses a popup on this origin's callback in a browser", () => {
    const result = platformSignInDrivers({
      issuerKind: "logto",
      isCapacitor: () => false,
      profile: "web-standalone",
    })
    expect(result).toEqual({
      drivers: { flavour: "popup" },
      redirectUri: `${window.location.origin}/logto/callback`,
      clientKind: "web",
    })
  })

  it("opens the system browser on the desktop and resolves from the deep link", async () => {
    const { drivers, redirectUri, clientKind } = platformSignInDrivers({
      issuerKind: undefined,
      isCapacitor: () => false,
      profile: "desktop",
    })
    expect(redirectUri).toBe(LOGTO_NATIVE_CALLBACK_URI)
    expect(clientKind).toBe("native")
    drivers.openUrl("https://issuer/authorize")
    expect(openUrl).toHaveBeenCalledWith("https://issuer/authorize")
    const pending = drivers.waitForCode({ state: "st", redirectUri })
    publishLogtoDeepLinkCallback(callback("st"))
    await expect(pending).resolves.toEqual({ code: "code-1", state: "st" })
  })

  it("races a pasted callback against the deep link on the desktop", async () => {
    const pasted = jest.fn(async (state: string) => ({ code: "pasted", state }))
    const { drivers } = platformSignInDrivers({
      issuerKind: "oidc",
      isCapacitor: () => false,
      profile: "desktop",
      pasted,
    })
    await expect(drivers.waitForCode({ state: "st", redirectUri: "x" })).resolves.toEqual({
      code: "pasted",
      state: "st",
    })
    expect(pasted).toHaveBeenCalledWith("st")
  })

  it("stops waiting for the deep link when the caller gives up", async () => {
    const controller = new AbortController()
    const { drivers } = platformSignInDrivers({
      issuerKind: "oidc",
      isCapacitor: () => false,
      profile: "desktop",
      signal: controller.signal,
    })
    const pending = drivers.waitForCode({ state: "st", redirectUri: "x" })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })
})
