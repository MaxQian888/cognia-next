import { piPackageScopesByIdentity, resolvePiPackages } from "./resolve"

const BASE = { user: "/home/u/.pi/agent", project: "/repo/.pi" }

describe("resolvePiPackages", () => {
  it("returns user packages untouched when the project declares none", () => {
    const resolved = resolvePiPackages(["npm:a@1.0.0", "npm:b@2.0.0"], [], BASE)
    expect(resolved.map((r) => r.identity)).toEqual(["npm:a", "npm:b"])
    expect(resolved.every((r) => r.scope === "user")).toBe(true)
  })

  /**
   * The bug this module exists to prevent: Pi's generic settings merge treats
   * arrays as replace, so reading a merged view would report the user's other
   * packages as gone the moment a repo declares one of its own.
   */
  it("does not drop user packages when the project declares an unrelated one", () => {
    const resolved = resolvePiPackages(["npm:a@1.0.0", "npm:b@2.0.0"], ["npm:c@3.0.0"], BASE)
    expect(resolved.map((r) => r.identity).sort()).toEqual(["npm:a", "npm:b", "npm:c"])
  })

  it("lets a project entry replace the user entry at the same identity", () => {
    const resolved = resolvePiPackages(["npm:a@1.0.0"], ["npm:a@9.9.9"], BASE)
    expect(resolved).toHaveLength(1)
    expect(resolved[0].scope).toBe("project")
    expect(resolved[0].pkg).toBe("npm:a@9.9.9")
  })

  /**
   * Pi's one non-obvious rule: `autoload: false` in the project makes that
   * entry a delta over the user entry, so both survive — delta first — and a
   * repo can narrow a globally installed package without redeclaring it.
   */
  it("keeps both entries when the project entry is an autoload:false delta", () => {
    const resolved = resolvePiPackages(
      ["npm:a@1.0.0"],
      [{ source: "npm:a", autoload: false, skills: [] }],
      BASE
    )
    expect(resolved).toHaveLength(2)
    expect(resolved[0].scope).toBe("project")
    expect(resolved[0].isDelta).toBe(false)
    expect(resolved[1].scope).toBe("user")
    expect(resolved[1].isDelta).toBe(true)
  })

  it("replaces rather than layers when the project entry keeps autoload on", () => {
    const resolved = resolvePiPackages(
      ["npm:a@1.0.0"],
      [{ source: "npm:a", autoload: true, skills: [] }],
      BASE
    )
    expect(resolved).toHaveLength(1)
    expect(resolved[0].scope).toBe("project")
  })

  it("orders project entries before user entries", () => {
    const resolved = resolvePiPackages(["npm:u"], ["npm:p"], BASE)
    expect(resolved.map((r) => r.scope)).toEqual(["project", "user"])
  })

  it("matches a project pin against a differently-pinned user entry", () => {
    // Identity ignores the version, so these are the same package.
    const resolved = resolvePiPackages(
      ["npm:pi-mcp-adapter@2.23.0"],
      ["npm:pi-mcp-adapter@2.0.0"],
      BASE
    )
    expect(resolved).toHaveLength(1)
    expect(resolved[0].pkg).toBe("npm:pi-mcp-adapter@2.0.0")
  })

  it("treats the same relative local path in two scopes as two packages", () => {
    const resolved = resolvePiPackages(["./ext"], ["./ext"], BASE)
    expect(resolved).toHaveLength(2)
    expect(resolved.map((r) => r.identity).sort()).toEqual([
      "local:/home/u/.pi/agent/ext",
      "local:/repo/.pi/ext",
    ])
  })

  it("de-duplicates a package declared twice in the same scope", () => {
    const resolved = resolvePiPackages(["npm:a@1.0.0", "npm:a@2.0.0"], [], BASE)
    expect(resolved).toHaveLength(1)
  })

  it("handles both scopes being empty", () => {
    expect(resolvePiPackages([], [], BASE)).toEqual([])
  })
})

describe("piPackageScopesByIdentity", () => {
  it("reports which scopes declared each package", () => {
    const map = piPackageScopesByIdentity(["npm:a", "npm:b"], ["npm:a"], BASE)
    expect(map.get("npm:a")).toEqual(["user", "project"])
    expect(map.get("npm:b")).toEqual(["user"])
  })

  it("does not repeat a scope that declared the same package twice", () => {
    const map = piPackageScopesByIdentity(["npm:a@1", "npm:a@2"], [], BASE)
    expect(map.get("npm:a")).toEqual(["user"])
  })
})
