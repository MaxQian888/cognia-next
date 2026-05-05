/**
 * OAuth registry tests — Task 80.
 *
 * Verifies that the slack platform key is registered and that invoking
 * the handler throws the expected Phase-1 stub error.
 */

import { oauthRegistry } from "./oauth-registry"

describe("oauthRegistry", () => {
  it("has the slack key registered", () => {
    expect(oauthRegistry.has("slack")).toBe(true)
  })

  it("slack handler throws Phase-1 stub error", async () => {
    const handler = oauthRegistry.get("slack")
    expect(handler).toBeDefined()
    await expect(handler!("fake-code")).rejects.toThrow("Slack OAuth exchange not yet implemented")
  })

  it("does not have telegram key registered (no OAuth)", () => {
    expect(oauthRegistry.has("telegram")).toBe(false)
  })

  it("does not have discord key registered (no OAuth)", () => {
    expect(oauthRegistry.has("discord")).toBe(false)
  })
})
