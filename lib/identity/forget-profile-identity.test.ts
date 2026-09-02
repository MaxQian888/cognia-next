jest.mock("@/lib/collab/connection", () => ({ forgetCollabConnection: jest.fn() }))
jest.mock("@/lib/logto/app-session", () => ({
  signOutFromLogto: jest.fn(),
  signOutLeftTokensLive: jest.requireActual("@/lib/logto/app-session").signOutLeftTokensLive,
}))
jest.mock("./host-person", () => ({ unbindHostPerson: jest.fn() }))
jest.mock("./user-binding", () => ({
  UserBindingRegistry: jest.fn().mockImplementation(() => ({ unbind: jest.fn() })),
}))

import { forgetCollabConnection } from "@/lib/collab/connection"
import { signOutFromLogto, type LogtoSignOutReport } from "@/lib/logto/app-session"

import { forgetProfileCloudIdentity, PROFILE_CLOUD_IDENTITY_STEPS } from "./forget-profile-identity"
import { unbindHostPerson } from "./host-person"

const signOut = signOutFromLogto as jest.Mock
const forgetConnection = forgetCollabConnection as jest.Mock
const unbindHost = unbindHostPerson as jest.Mock

function report(over: Partial<LogtoSignOutReport> = {}): LogtoSignOutReport {
  return {
    hadSession: true,
    cleared: true,
    refreshTokenRevocation: { status: "revoked" },
    accessTokenRevocation: { status: "revoked" },
    endSessionUrl: null,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  signOut.mockResolvedValue(report())
  unbindHost.mockResolvedValue(true)
})

describe("forgetProfileCloudIdentity", () => {
  it("runs every step for the unlocked profile and reports a clean result", async () => {
    const registry = { unbind: jest.fn(async () => {}) }
    const result = await forgetProfileCloudIdentity("acct_a", { registry, hostBound: true })

    expect(signOut).toHaveBeenCalledWith({ localAccountId: "acct_a" })
    expect(registry.unbind).toHaveBeenCalledWith("acct_a")
    expect(forgetConnection).toHaveBeenCalledWith("acct_a")
    expect(unbindHost).toHaveBeenCalledWith("acct_a", undefined)
    expect(Object.keys(result.steps).sort()).toEqual([...PROFILE_CLOUD_IDENTITY_STEPS].sort())
    expect(Object.values(result.steps).every((step) => step.status === "done")).toBe(true)
    expect(result.failures).toEqual([])
    expect(result.tokensMayRemainLive).toBe(false)
  })

  it("skips the host for a profile the host does not hold, rather than failing it", async () => {
    const result = await forgetProfileCloudIdentity("acct_b", {
      registry: { unbind: jest.fn(async () => {}) },
      hostBound: false,
    })
    expect(unbindHost).not.toHaveBeenCalled()
    expect(result.steps["host-person"]).toEqual({ status: "skipped", reason: "not-bound-on-host" })
    expect(result.failures).toEqual([])
  })

  it("reports a shell with no host as skipped, not done", async () => {
    unbindHost.mockResolvedValue(false)
    const result = await forgetProfileCloudIdentity("acct_a", {
      registry: { unbind: jest.fn(async () => {}) },
      hostBound: true,
    })
    expect(result.steps["host-person"]).toEqual({ status: "skipped", reason: "no-host" })
  })

  it("keeps going past a failed step and lists it", async () => {
    const registry = {
      unbind: jest.fn(async () => {
        throw new Error("registry locked")
      }),
    }
    const result = await forgetProfileCloudIdentity("acct_a", { registry, hostBound: true })
    expect(result.steps.binding).toEqual({ status: "failed", error: "registry locked" })
    expect(result.failures).toEqual([{ step: "binding", error: "registry locked" }])
    // The later steps still ran.
    expect(forgetConnection).toHaveBeenCalledTimes(1)
    expect(unbindHost).toHaveBeenCalledTimes(1)
    expect(result.tokensMayRemainLive).toBe(false)
  })

  it("records a failed connection forget and a failed host unbind without stopping", async () => {
    forgetConnection.mockImplementationOnce(() => {
      throw new Error("storage denied")
    })
    unbindHost.mockRejectedValueOnce(new Error("host down"))
    const result = await forgetProfileCloudIdentity("acct_a", {
      registry: { unbind: jest.fn(async () => {}) },
      hostBound: true,
    })
    expect(result.steps["collab-connection"]).toEqual({ status: "failed", error: "storage denied" })
    expect(result.steps["host-person"]).toEqual({ status: "failed", error: "host down" })
    expect(result.failures.map((failure) => failure.step)).toEqual([
      "collab-connection",
      "host-person",
    ])
    expect(result.tokensMayRemainLive).toBe(false)
  })

  it("flags live tokens when the keyring could not be cleared", async () => {
    signOut.mockRejectedValue(new Error("keyring unavailable"))
    const result = await forgetProfileCloudIdentity("acct_a", {
      registry: { unbind: jest.fn(async () => {}) },
    })
    expect(result.steps.session).toEqual({ status: "failed", error: "keyring unavailable" })
    expect(result.tokensMayRemainLive).toBe(true)
    expect(result).not.toHaveProperty("signOut")
  })

  it("flags live tokens when the issuer could not be told to revoke", async () => {
    signOut.mockResolvedValue(
      report({ refreshTokenRevocation: { status: "failed", reason: "ECONNREFUSED" } })
    )
    const result = await forgetProfileCloudIdentity("acct_a", {
      registry: { unbind: jest.fn(async () => {}) },
    })
    expect(result.steps.session).toEqual({ status: "done" })
    expect(result.tokensMayRemainLive).toBe(true)
    expect(result.failures).toEqual([])
  })

  it("a profile that was never signed in cleans up with nothing to report", async () => {
    signOut.mockResolvedValue(
      report({ hadSession: false, refreshTokenRevocation: null, accessTokenRevocation: null })
    )
    const result = await forgetProfileCloudIdentity("acct_never", {
      registry: { unbind: jest.fn(async () => {}) },
    })
    expect(result.tokensMayRemainLive).toBe(false)
    expect(result.failures).toEqual([])
  })
})
