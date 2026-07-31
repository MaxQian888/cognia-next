import upstreamInventory from "@/packages/plugin-sdk/contract/code-1.128-upstream-extension-points.json"
import upstreamProviderInventory from "@/packages/plugin-sdk/contract/code-1.128-upstream-provider-apis.json"
import {
  IDE_CAPABILITY_CATALOG,
  IDE_EXCLUDED_CONTRIBUTIONS,
  IDE_EXCLUDED_PROVIDERS,
  IDE_PROVIDER_KINDS,
} from "./catalog"

describe("Code 1.128 IDE capability catalog", () => {
  it("classifies every contribution and provider exactly once", () => {
    expect(new Set(IDE_CAPABILITY_CATALOG.contributions).size).toBe(
      IDE_CAPABILITY_CATALOG.contributions.length
    )
    expect(new Set(IDE_PROVIDER_KINDS).size).toBe(IDE_PROVIDER_KINDS.length)
    expect(IDE_CAPABILITY_CATALOG.codeApiVersion).toBe("1.128.0")
    expect(IDE_CAPABILITY_CATALOG.brokerProtocol).toBe("1.0")
  })

  it("records every deliberate exclusion as a structured error code", () => {
    expect(IDE_CAPABILITY_CATALOG.exclusions.map((entry) => entry.id)).toEqual([
      "proposed-api",
      "internal-api",
      "remote-authority",
      "extension-management",
      "windows-host",
      "third-party-extension-dependency",
    ])
    for (const exclusion of IDE_CAPABILITY_CATALOG.exclusions) {
      expect(exclusion.code).toMatch(/^IDE_[A-Z_]+$/)
    }
  })

  it("classifies every locked upstream extension point as supported or excluded", () => {
    const supported = new Set(IDE_CAPABILITY_CATALOG.contributions)
    for (const entry of upstreamInventory.extensionPoints) {
      if (entry.classification === "supported") {
        expect(supported.has(entry.id)).toBe(true)
        expect(IDE_EXCLUDED_CONTRIBUTIONS.has(entry.id)).toBe(false)
      } else {
        expect(supported.has(entry.id)).toBe(false)
        expect(IDE_EXCLUDED_CONTRIBUTIONS.get(entry.id)).toMatch(/^IDE_[A-Z_]+$/)
      }
    }
    expect(upstreamInventory.source.tag).toBe(IDE_CAPABILITY_CATALOG.codeApiVersion)
  })

  it("maps every locked stable provider API to a supported provider family", () => {
    const supported = new Set<string>(IDE_PROVIDER_KINDS)
    const covered = new Set<string>()
    for (const entry of upstreamProviderInventory.providerApis) {
      if (entry.classification === "supported") {
        expect(supported.has(entry.providerKind)).toBe(true)
        expect(IDE_EXCLUDED_PROVIDERS.has(entry.providerKind)).toBe(false)
        covered.add(entry.providerKind)
      } else {
        expect(supported.has(entry.providerKind)).toBe(false)
        expect(IDE_EXCLUDED_PROVIDERS.get(entry.providerKind)).toMatch(/^IDE_[A-Z_]+$/)
      }
    }
    expect(covered).toEqual(supported)
    expect(upstreamProviderInventory.source.tag).toBe(IDE_CAPABILITY_CATALOG.codeApiVersion)
    expect(upstreamProviderInventory.source.stableDtsSha256).toMatch(/^[a-f0-9]{64}$/)
  })
})
