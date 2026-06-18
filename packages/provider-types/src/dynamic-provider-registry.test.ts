import {
  getDynamicProviders,
  setDynamicProviderRegistry,
  type DynamicProviderRegistry,
} from "./dynamic-provider-registry"
import type { ProviderConfig } from "./provider"

describe("dynamic-provider-registry", () => {
  // Restore the default empty registry after each test so cases don't leak.
  afterEach(() => {
    setDynamicProviderRegistry(() => ({}))
  })

  it("returns an empty map by default (no host wired)", () => {
    setDynamicProviderRegistry(() => ({}))
    expect(getDynamicProviders()).toEqual({})
  })

  it("reads through the wired registry", () => {
    const fake = { "plugin:x": { id: "plugin:x" } as unknown as ProviderConfig }
    const fn: DynamicProviderRegistry = () => fake
    setDynamicProviderRegistry(fn)
    expect(getDynamicProviders()).toBe(fake)
  })

  it("uses the most recently wired registry", () => {
    setDynamicProviderRegistry(() => ({ a: { id: "a" } as unknown as ProviderConfig }))
    setDynamicProviderRegistry(() => ({ b: { id: "b" } as unknown as ProviderConfig }))
    expect(Object.keys(getDynamicProviders())).toEqual(["b"])
  })

  it("re-evaluates the getter on every call (live, not snapshotted)", () => {
    let n = 0
    setDynamicProviderRegistry(() => ({
      [`p${n++}`]: { id: `p${n}` } as unknown as ProviderConfig,
    }))
    expect(Object.keys(getDynamicProviders())).toEqual(["p0"])
    expect(Object.keys(getDynamicProviders())).toEqual(["p1"])
  })
})
