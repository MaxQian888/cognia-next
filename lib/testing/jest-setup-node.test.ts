describe("Jest Node setup", () => {
  it("does not install DOM-only matchers", () => {
    expect(typeof expect(null).toBeInTheDocument).toBe("undefined")
    expect(globalThis.ResizeObserver).toBeUndefined()
    expect(globalThis.IntersectionObserver).toBeUndefined()
    expect(
      (globalThis as { __PLUGIN_CONSENT_AUTO?: "allow" | "deny" | "off" }).__PLUGIN_CONSENT_AUTO
    ).toBeUndefined()
  })
})
