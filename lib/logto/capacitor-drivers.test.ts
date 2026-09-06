/** @jest-environment jsdom */

import { LogtoSignInCancelled, createLogtoCapacitorDrivers } from "./capacitor-drivers"

import type { CallbackOutcome, RunOAuthOptions } from "@/lib/oauth/mobile-flow"

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

  it("refuses to wait for a URL that was never opened", async () => {
    const { drivers } = driversWith({ kind: "cancelled" })
    await expect(drivers.waitForCode({ state: "st", redirectUri: "x" })).rejects.toThrow(
      "never opened"
    )
  })
})
