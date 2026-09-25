import type { GatewayStatus } from "@/types/gateway"

import { isGatewayAccountLocked } from "./status"

const status = (over: Partial<GatewayStatus> = {}): GatewayStatus => ({
  running: false,
  boundPort: null,
  hasToken: false,
  bindInterface: "loopback",
  pendingRestartFields: [],
  callsTotal: 0,
  lastCallAt: null,
  snapshotGeneratedAtMs: null,
  snapshotProviderCount: 0,
  snapshotAliasCount: 0,
  ...over,
})

describe("isGatewayAccountLocked", () => {
  it("is true only for an account-scoped gateway with no unlocked account", () => {
    expect(isGatewayAccountLocked(status({ accountRequired: true, ownerAccountId: null }))).toBe(
      true
    )
    expect(isGatewayAccountLocked(status({ accountRequired: true }))).toBe(true)
    expect(isGatewayAccountLocked(status({ accountRequired: true, ownerAccountId: "a" }))).toBe(
      false
    )
    expect(isGatewayAccountLocked(status({ accountRequired: false }))).toBe(false)
    expect(isGatewayAccountLocked(null)).toBe(false)
  })
})
