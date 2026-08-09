/** @jest-environment jsdom */

describe("Jest jsdom setup", () => {
  it("installs DOM matchers for a node-project docblock override", () => {
    const element = document.createElement("div")
    document.body.append(element)

    expect(element).toBeInTheDocument()
  })

  it("installs browser-only test shims", () => {
    expect(window.matchMedia("(max-width: 640px)").matches).toBe(false)
    expect(globalThis.ResizeObserver).toBeDefined()
    expect(globalThis.IntersectionObserver).toBeDefined()
    expect(window.structuredClone).toBe(globalThis.structuredClone)
    expect(
      (globalThis as { __PLUGIN_CONSENT_AUTO?: "allow" | "deny" | "off" }).__PLUGIN_CONSENT_AUTO
    ).toBe("allow")
  })
})
