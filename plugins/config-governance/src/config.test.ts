import { DEFAULT_GOVERNANCE_CONFIG, readGovernanceConfig } from "./config"
import manifest from "../plugin.json"

function source(values: Record<string, unknown>) {
  return {
    getOrDefault: <T>(key: string, fallback: T) => (key in values ? (values[key] as T) : fallback),
  }
}

describe("readGovernanceConfig", () => {
  it("falls back to the defaults", () => {
    expect(readGovernanceConfig(source({}))).toEqual(DEFAULT_GOVERNANCE_CONFIG)
  })

  it("trims strings, clamps the session limit and reads booleans strictly", () => {
    expect(
      readGovernanceConfig(
        source({
          auditShipped: "yes",
          auditModel: " m ",
          targetModel: 3,
          backtestSessionLimit: 9999,
          enforcementEnabled: false,
        })
      )
    ).toEqual({
      auditShipped: false,
      auditModel: "m",
      targetModel: "",
      backtestSessionLimit: 500,
      enforcementEnabled: false,
    })
    expect(readGovernanceConfig(source({ backtestSessionLimit: "abc" })).backtestSessionLimit).toBe(
      50
    )
    expect(readGovernanceConfig(source({ backtestSessionLimit: 1 })).backtestSessionLimit).toBe(5)
  })

  it("matches the manifest's schema defaults", () => {
    const properties = manifest.configSchema.properties as Record<string, { default: unknown }>
    for (const [key, value] of Object.entries(DEFAULT_GOVERNANCE_CONFIG)) {
      expect(properties[key]?.default).toEqual(value)
    }
  })
})
