import { E2B_PROVISIONING_AVAILABLE, isProvisioningAvailable } from "./provisioning"

describe("E2B provisioning gate", () => {
  // Pins the dormancy (CLAUDE.md rule 7). Flipping the gate is a deliberate
  // change: it must land with a host-side bridge that can load the `e2b` SDK,
  // or Settings → Sandbox offers a microVM tier that can only fail.
  it("stays off until a host bridge can load the e2b SDK", () => {
    expect(E2B_PROVISIONING_AVAILABLE).toBe(false)
    expect(isProvisioningAvailable()).toBe(false)
  })
})
