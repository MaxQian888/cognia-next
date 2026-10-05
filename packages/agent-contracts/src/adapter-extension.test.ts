import type { ExternalAgentAdapterCore } from "./adapter"
import { defineAdapterExtension } from "./adapter-extension"

class Special {
  readonly marker = "special"
}

describe("defineAdapterExtension", () => {
  it("resolves only adapters the integration recognises", () => {
    const extension = defineAdapterExtension<Special>("vendor.special", (adapter) =>
      adapter instanceof Special ? adapter : undefined
    )
    const special = new Special() as unknown as ExternalAgentAdapterCore
    expect(extension.resolve(special)).toBe(special)
    expect(extension.resolve({} as ExternalAgentAdapterCore)).toBeUndefined()
    expect(extension.id).toBe("vendor.special")
    expect(Object.isFrozen(extension)).toBe(true)
  })

  it("requires a namespaced id", () => {
    expect(() => defineAdapterExtension("special", () => undefined)).toThrow(/namespaced/)
    expect(() => defineAdapterExtension("Vendor.Special", () => undefined)).toThrow(/namespaced/)
  })
})
