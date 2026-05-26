import { companionConfigToPairedSummary } from "./paired-summary"
import type { CompanionConfig } from "@/lib/tauri/transport-companion"

function config(overrides: Partial<CompanionConfig> = {}): CompanionConfig {
  return {
    baseUrl: "https://192.168.1.42:7890",
    deviceJwt: "jwt",
    deviceId: "device-1234567890",
    serverVersion: "0.4.2",
    serverFingerprint: "ABCDEF0123456789",
    ...overrides,
  } as CompanionConfig
}

describe("companionConfigToPairedSummary", () => {
  it("returns null for a null config", () => {
    expect(companionConfigToPairedSummary(null)).toBeNull()
  })

  it("projects host, explicit port, and fingerprint", () => {
    const summary = companionConfigToPairedSummary(config())
    expect(summary).toEqual({
      ip: "192.168.1.42",
      port: 7890,
      fingerprint: "ABCDEF0123456789",
      label: "device-1",
    })
  })

  it("defaults to 443 for https without an explicit port", () => {
    const summary = companionConfigToPairedSummary(config({ baseUrl: "https://desk.local" }))
    expect(summary?.ip).toBe("desk.local")
    expect(summary?.port).toBe(443)
  })

  it("defaults to 80 for http without an explicit port", () => {
    const summary = companionConfigToPairedSummary(config({ baseUrl: "http://10.0.0.5" }))
    expect(summary?.port).toBe(80)
  })

  it("returns null when the baseUrl can't be parsed", () => {
    expect(companionConfigToPairedSummary(config({ baseUrl: "not a url" }))).toBeNull()
  })

  it("omits the label when deviceId is empty", () => {
    const summary = companionConfigToPairedSummary(config({ deviceId: "" }))
    expect(summary?.label).toBeUndefined()
  })
})
