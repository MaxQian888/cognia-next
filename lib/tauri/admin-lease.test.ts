import { transport } from "@/lib/tauri"
import { issueHostAdminLease, revokeHostAdminLeases } from "./admin-lease"

describe("host admin lease", () => {
  afterEach(() => jest.restoreAllMocks())

  it("binds the explicit confirmation to a narrow operation list and ten-minute TTL", async () => {
    const call = jest.spyOn(transport, "call").mockResolvedValue({
      token: "lease",
      operations: ["skills_install_atomic"],
      expiresAt: Date.now() + 600_000,
    })

    await issueHostAdminLease(["skills_install_atomic"])

    expect(call).toHaveBeenCalledWith("host_admin_lease_issue", {
      operations: ["skills_install_atomic"],
      ttlSeconds: 600,
      confirmed: true,
    })
  })

  it("revokes every lease for the current device", async () => {
    const call = jest.spyOn(transport, "call").mockResolvedValue(undefined)
    await revokeHostAdminLeases()
    expect(call).toHaveBeenCalledWith("host_admin_lease_revoke")
  })
})
