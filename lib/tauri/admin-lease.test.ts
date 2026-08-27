import { transport } from "@/lib/tauri"
import {
  HostConsentRequiredError,
  hostConsentCodeFrom,
  isHostConsentRequired,
  issueHostAdminLease,
  revokeHostAdminLeases,
} from "./admin-lease"

describe("host admin lease", () => {
  afterEach(() => jest.restoreAllMocks())

  it("asks for a narrow operation list and a ten-minute window, and asserts nothing", async () => {
    const call = jest.spyOn(transport, "call").mockResolvedValue({
      token: "lease",
      operations: ["skills_install_atomic"],
      expiresAt: Date.now() + 600_000,
    })

    await issueHostAdminLease(["skills_install_atomic"])

    // No `confirmed`. The argument used to be sent as `true` unconditionally,
    // which is how a command declared `approval: interactive` met no gate.
    expect(call).toHaveBeenCalledWith("host_admin_lease_issue", {
      operations: ["skills_install_atomic"],
      ttlSeconds: 600,
    })
    expect(call.mock.calls[0][1]).not.toHaveProperty("confirmed")
  })

  it("turns the host's refusal into something a form can act on", async () => {
    jest
      .spyOn(transport, "call")
      .mockRejectedValue(
        new Error("REMOTE_CONSENT_REQUIRED: this device needs approval on the host (code A1B2C3D4)")
      )

    const error = await issueHostAdminLease(["connectors_keyring_get"]).catch((e) => e)

    expect(error).toBeInstanceOf(HostConsentRequiredError)
    expect((error as HostConsentRequiredError).consentCode).toBe("A1B2C3D4")
  })

  it("leaves every other failure exactly as the host phrased it", async () => {
    const denied = new Error("REMOTE_SCOPE_DENIED: only an explicitly registered host owner")
    jest.spyOn(transport, "call").mockRejectedValue(denied)

    await expect(issueHostAdminLease(["connectors_keyring_get"])).rejects.toBe(denied)
  })

  it("survives a host that refuses without naming a code", async () => {
    jest.spyOn(transport, "call").mockRejectedValue(new Error("REMOTE_CONSENT_REQUIRED: nope"))

    const error = await issueHostAdminLease(["x"]).catch((e) => e)

    expect(error).toBeInstanceOf(HostConsentRequiredError)
    expect((error as HostConsentRequiredError).consentCode).toBeNull()
  })

  it("revokes every lease for the current device", async () => {
    const call = jest.spyOn(transport, "call").mockResolvedValue(undefined)
    await revokeHostAdminLeases()
    expect(call).toHaveBeenCalledWith("host_admin_lease_revoke")
  })
})

describe("consent refusal parsing", () => {
  it("recognises the refusal wherever it sits in the message", () => {
    expect(isHostConsentRequired(new Error("rpc failed: REMOTE_CONSENT_REQUIRED: x"))).toBe(true)
    expect(isHostConsentRequired("REMOTE_CONSENT_REQUIRED")).toBe(true)
    expect(isHostConsentRequired(new Error("REMOTE_SCOPE_DENIED"))).toBe(false)
    expect(isHostConsentRequired(null)).toBe(false)
  })

  it("reads the code case-insensitively in shape but verbatim in value", () => {
    expect(hostConsentCodeFrom(new Error("… (code 0a1b2c3d)"))).toBe("0a1b2c3d")
    expect(hostConsentCodeFrom(new Error("… (code   AB12)"))).toBe("AB12")
    expect(hostConsentCodeFrom(new Error("no code here"))).toBeNull()
  })
})
