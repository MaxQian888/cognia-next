import {
  DEFAULT_PERMISSION_PROFILE,
  compactPermissionProfile,
  PERMISSION_CLASSES,
  isPermissionLevelFor,
  narrowPermissionLevel,
  narrowPermissionProfile,
  resolvePermissionProfile,
  tightenedPermissionClasses,
  validatePermissionProfile,
  widenedPermissionClasses,
} from "./unattended-permission"

describe("unattended permission profile", () => {
  it("has the ADR's ceiling: sandboxed workspace work, everything else asks", () => {
    expect(DEFAULT_PERMISSION_PROFILE).toEqual({
      workspace: "sandbox",
      outbound: "ask",
      secrets: "ask",
      hostConfig: "ask",
    })
    expect(Object.isFrozen(DEFAULT_PERMISSION_PROFILE)).toBe(true)
    expect(PERMISSION_CLASSES).toEqual(["workspace", "outbound", "secrets", "hostConfig"])
  })

  it("narrows each level to the stricter one", () => {
    expect(narrowPermissionLevel("sandbox", "ask")).toBe("ask")
    expect(narrowPermissionLevel("ask", "sandbox")).toBe("ask")
    expect(narrowPermissionLevel("ask", "deny")).toBe("deny")
    expect(narrowPermissionLevel("sandbox", "sandbox")).toBe("sandbox")
  })

  it("only accepts sandbox on the workspace class", () => {
    expect(isPermissionLevelFor("workspace", "sandbox")).toBe(true)
    expect(isPermissionLevelFor("outbound", "sandbox")).toBe(false)
    expect(isPermissionLevelFor("secrets", "deny")).toBe(true)
    expect(isPermissionLevelFor("hostConfig", "allow")).toBe(false)
  })

  it("folds two layers class by class and keeps unnamed classes absent", () => {
    expect(narrowPermissionProfile(undefined, undefined)).toBeUndefined()
    expect(narrowPermissionProfile({ outbound: "deny" }, undefined)).toEqual({ outbound: "deny" })
    expect(
      narrowPermissionProfile(
        { workspace: "ask", outbound: "deny" },
        { workspace: "sandbox", secrets: "deny" }
      )
    ).toEqual({ workspace: "ask", outbound: "deny", secrets: "deny" })
  })

  it("cannot be widened by a later layer", () => {
    expect(narrowPermissionProfile({ outbound: "deny" }, { outbound: "ask" })).toEqual({
      outbound: "deny",
    })
    expect(narrowPermissionProfile({ workspace: "deny" }, { workspace: "sandbox" })).toEqual({
      workspace: "deny",
    })
  })

  it("resolves every class and never rises above the ceiling", () => {
    expect(resolvePermissionProfile(undefined)).toEqual(DEFAULT_PERMISSION_PROFILE)
    expect(resolvePermissionProfile({ workspace: "deny", secrets: "deny" })).toEqual({
      workspace: "deny",
      outbound: "ask",
      secrets: "deny",
      hostConfig: "ask",
    })
    // A level a class does not accept is ignored rather than trusted.
    expect(
      resolvePermissionProfile({ outbound: "sandbox" } as unknown as Parameters<
        typeof resolvePermissionProfile
      >[0])
    ).toEqual(DEFAULT_PERMISSION_PROFILE)
  })

  it("names the classes a candidate asks to loosen", () => {
    expect(widenedPermissionClasses({ workspace: "ask" }, { workspace: "sandbox" })).toEqual([
      "workspace",
    ])
    // A class the candidate does not name is no opinion.
    expect(widenedPermissionClasses({ outbound: "deny" }, {})).toEqual([])
    expect(widenedPermissionClasses({ outbound: "ask" }, { outbound: "deny" })).toEqual([])
    expect(widenedPermissionClasses(undefined, { secrets: "deny" })).toEqual([])
  })

  it("names the classes a new profile makes stricter", () => {
    expect(tightenedPermissionClasses(undefined, { outbound: "deny" })).toEqual(["outbound"])
    expect(tightenedPermissionClasses({ workspace: "ask" }, { workspace: "deny" })).toEqual([
      "workspace",
    ])
    expect(tightenedPermissionClasses({ workspace: "deny" }, {})).toEqual([])
    expect(tightenedPermissionClasses({ secrets: "deny" }, { secrets: "deny" })).toEqual([])
  })

  it("validates a profile crossing a trust boundary", () => {
    expect(validatePermissionProfile({ workspace: "ask", hostConfig: "deny" })).toEqual({
      ok: true,
      value: { workspace: "ask", hostConfig: "deny" },
    })
    expect(validatePermissionProfile(null)).toEqual({
      ok: false,
      errors: ["permissionProfile must be an object"],
    })
    expect(validatePermissionProfile({ outbound: "sandbox", network: "deny" })).toEqual({
      ok: false,
      errors: [
        "permissionProfile.outbound must be one of ask|deny",
        "permissionProfile.network is not a permission class",
      ],
    })
  })

  it("compacts a profile to the classes it narrows below the ceiling", () => {
    expect(compactPermissionProfile(undefined)).toBeUndefined()
    expect(compactPermissionProfile({})).toBeUndefined()
    expect(
      compactPermissionProfile({ workspace: "sandbox", outbound: "ask", hostConfig: "ask" })
    ).toBeUndefined()
    expect(
      compactPermissionProfile({ workspace: "ask", secrets: "deny", outbound: "ask" })
    ).toEqual({ workspace: "ask", secrets: "deny" })
    // A level the class does not accept is no opinion, not an error here.
    expect(
      compactPermissionProfile({ outbound: "sandbox" } as unknown as Parameters<
        typeof compactPermissionProfile
      >[0])
    ).toBeUndefined()
  })
})
