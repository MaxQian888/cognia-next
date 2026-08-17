import { asPiPackageEntry, isPiPackageAutoloaded, piPackageSourceString } from "./types"

describe("piPackageSourceString", () => {
  it("reads the spec out of both entry forms", () => {
    expect(piPackageSourceString("npm:a@1.0.0")).toBe("npm:a@1.0.0")
    expect(piPackageSourceString({ source: "npm:a@1.0.0", skills: [] })).toBe("npm:a@1.0.0")
  })
})

describe("asPiPackageEntry", () => {
  it("wraps a string without inventing fields", () => {
    expect(asPiPackageEntry("npm:a")).toEqual({ source: "npm:a" })
  })

  it("returns an object entry unchanged", () => {
    const entry = { source: "npm:a", autoload: false, skills: [] }
    expect(asPiPackageEntry(entry)).toBe(entry)
  })
})

describe("isPiPackageAutoloaded", () => {
  /**
   * Pi has no `enabled` field — `autoload: false` is the "installed but inert"
   * state, and its absence means autoloaded.
   */
  it("treats a bare string as autoloaded", () => {
    expect(isPiPackageAutoloaded("npm:a")).toBe(true)
  })

  it("treats an object with no autoload key as autoloaded", () => {
    expect(isPiPackageAutoloaded({ source: "npm:a", skills: [] })).toBe(true)
  })

  it("treats autoload:true as autoloaded", () => {
    expect(isPiPackageAutoloaded({ source: "npm:a", autoload: true })).toBe(true)
  })

  it("treats autoload:false as inert", () => {
    expect(isPiPackageAutoloaded({ source: "npm:a", autoload: false })).toBe(false)
  })
})
