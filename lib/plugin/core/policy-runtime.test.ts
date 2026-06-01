/**
 * @jest-environment jsdom
 */

const setGovernance = jest.fn()
const setSignatureConfig = jest.fn()
const configureAutoUpdate = jest.fn()

jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({ setPluginPointGovernanceMode: setGovernance }),
}))

jest.mock("@/lib/plugin/security/signature", () => ({
  getPluginSignatureVerifier: () => ({ setConfig: setSignatureConfig }),
}))

jest.mock("@/lib/plugin/lifecycle/updater", () => ({
  getPluginUpdater: () => ({ configureAutoUpdate }),
}))

import { applyPluginPolicyToRuntime } from "./policy-runtime"

beforeEach(() => {
  setGovernance.mockReset()
  setSignatureConfig.mockReset()
  configureAutoUpdate.mockReset()
})

describe("applyPluginPolicyToRuntime", () => {
  it("fans the policy snapshot out to manager + verifier + updater", () => {
    applyPluginPolicyToRuntime({
      governance: "block",
      signatureRequired: true,
      autoUpdate: true,
    })

    expect(setGovernance).toHaveBeenCalledWith("block")
    expect(setSignatureConfig).toHaveBeenCalledWith({
      requireSignatures: true,
      trustedPublishersOnly: false,
      allowUntrusted: true,
    })
    expect(configureAutoUpdate).toHaveBeenCalledWith({
      enabled: true,
      checkInterval: 24 * 60 * 60 * 1000,
      autoInstall: false,
      notifyOnly: true,
      excludePlugins: [],
      allowPrerelease: false,
    })
  })

  it("passes false flags through unchanged so toggling off truly stops the runtime work", () => {
    applyPluginPolicyToRuntime({
      governance: "warn",
      signatureRequired: false,
      autoUpdate: false,
    })

    expect(setGovernance).toHaveBeenCalledWith("warn")
    expect(setSignatureConfig).toHaveBeenCalledWith({
      requireSignatures: false,
      trustedPublishersOnly: false,
      allowUntrusted: true,
    })
    expect(configureAutoUpdate).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
  })

  it("trustedPublishersOnly tightens the verifier (rejects unknown signers)", () => {
    applyPluginPolicyToRuntime({
      governance: "warn",
      signatureRequired: true,
      trustedPublishersOnly: true,
      autoUpdate: false,
    })
    expect(setSignatureConfig).toHaveBeenCalledWith({
      requireSignatures: true,
      trustedPublishersOnly: true,
      allowUntrusted: false,
    })
  })

  it("swallows manager errors so an uninitialized manager doesn't bring down the other two", () => {
    setGovernance.mockImplementationOnce(() => {
      throw new Error("not booted yet")
    })

    expect(() =>
      applyPluginPolicyToRuntime({
        governance: "block",
        signatureRequired: true,
        autoUpdate: true,
      })
    ).not.toThrow()
    expect(setSignatureConfig).toHaveBeenCalledTimes(1)
    expect(configureAutoUpdate).toHaveBeenCalledTimes(1)
  })

  it("swallows signature-verifier errors so the updater still gets configured", () => {
    setSignatureConfig.mockImplementationOnce(() => {
      throw new Error("verifier missing")
    })

    expect(() =>
      applyPluginPolicyToRuntime({
        governance: "warn",
        signatureRequired: false,
        autoUpdate: true,
      })
    ).not.toThrow()
    expect(configureAutoUpdate).toHaveBeenCalledTimes(1)
  })

  it("swallows updater errors so partial wiring doesn't crash the caller", () => {
    configureAutoUpdate.mockImplementationOnce(() => {
      throw new Error("updater missing")
    })

    expect(() =>
      applyPluginPolicyToRuntime({
        governance: "warn",
        signatureRequired: false,
        autoUpdate: false,
      })
    ).not.toThrow()
  })
})
