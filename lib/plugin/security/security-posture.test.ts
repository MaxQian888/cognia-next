import {
  __setPluginSecurityPostureForTesting,
  getPluginSecurityPosture,
  setPluginSecurityPostureSource,
} from "./security-posture"

afterEach(() => {
  __setPluginSecurityPostureForTesting(null)
  setPluginSecurityPostureSource(null)
})

describe("getPluginSecurityPosture", () => {
  it("defaults to balanced with no source registered", () => {
    expect(getPluginSecurityPosture()).toBe("balanced")
  })

  it("reads from the registered source", () => {
    setPluginSecurityPostureSource(() => "strict")
    expect(getPluginSecurityPosture()).toBe("strict")
  })

  it("falls back to balanced when the source returns undefined", () => {
    setPluginSecurityPostureSource(() => undefined)
    expect(getPluginSecurityPosture()).toBe("balanced")
  })

  it("test override wins over the source", () => {
    setPluginSecurityPostureSource(() => "balanced")
    __setPluginSecurityPostureForTesting("strict")
    expect(getPluginSecurityPosture()).toBe("strict")
  })

  it("detaches the source when set to null", () => {
    setPluginSecurityPostureSource(() => "strict")
    setPluginSecurityPostureSource(null)
    expect(getPluginSecurityPosture()).toBe("balanced")
  })
})
