import { HostConsentRequiredError } from "./admin-lease"
import { withInteractiveApproval } from "./interactive-approval"

describe("withInteractiveApproval", () => {
  it("leaves a call this host runs itself unchanged and mints nothing", async () => {
    const issue = jest.fn()
    await expect(
      withInteractiveApproval("bot_installation_mutate", { a: 1 }, { isRemote: () => false, issue })
    ).resolves.toEqual({ a: 1 })
    expect(issue).not.toHaveBeenCalled()
  })

  it("attaches a lease minted for exactly this command on a paired host", async () => {
    const issue = jest.fn(async () => ({ token: "lease-1" }))
    await expect(
      withInteractiveApproval(
        "companion_push_configure_fcm",
        { x: "y" },
        { isRemote: () => true, issue }
      )
    ).resolves.toEqual({ x: "y", adminLease: "lease-1" })
    expect(issue).toHaveBeenCalledWith(["companion_push_configure_fcm"])
  })

  it("passes on a host waiting for a person, code and all", async () => {
    const issue = jest.fn(async () => {
      throw new HostConsentRequiredError("REMOTE_CONSENT_REQUIRED (code K7Q2)", "K7Q2")
    })
    await expect(
      withInteractiveApproval("bot_trigger_set_armed", {}, { isRemote: () => true, issue })
    ).rejects.toMatchObject({ consentCode: "K7Q2" })
  })
})
