import type { PairedDeviceRow } from "@/types/mobile/paired-device"

import { threadHandoffTargetUnavailableReason } from "./thread-handoff-source-dialog"

function device(overrides: Partial<PairedDeviceRow> = {}): PairedDeviceRow {
  return {
    deviceId: "phone-1",
    label: "Phone",
    platform: "ios",
    pubkey: "key",
    pairedAt: 1,
    lastSeenAt: 1,
    allowRemoteTerminal: false,
    appVersion: "1",
    capabilities: ["thread-handoff-v1"],
    ...overrides,
  }
}

describe("threadHandoffTargetUnavailableReason", () => {
  it("allows only active native mobile devices advertising standalone handoff", () => {
    expect(threadHandoffTargetUnavailableReason(device())).toBeNull()
    expect(threadHandoffTargetUnavailableReason(device({ platform: "web" }))).toBe("not-mobile")
    expect(threadHandoffTargetUnavailableReason(device({ capabilities: ["webview"] }))).toBe(
      "standalone-required"
    )
    expect(threadHandoffTargetUnavailableReason(device({ pausedAt: 2 }))).toBe("paused")
    expect(threadHandoffTargetUnavailableReason(device({ revokedAt: 2 }))).toBe("revoked")
  })
})
