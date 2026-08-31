import { resolveSurfaceReach, SURFACE_BLOCKS } from "./surface-reach"

describe("resolveSurfaceReach", () => {
  it("lets a desktop through when it holds the capability", () => {
    expect(resolveSurfaceReach({ profile: "desktop", capabilityAvailable: true })).toEqual({
      available: true,
    })
  })

  it("says a standalone browser has no host at all, and points at pairing", () => {
    // Not "the host lacks it": there is no host. The distinction is the whole
    // reason this returns a reason instead of a boolean.
    expect(resolveSurfaceReach({ profile: "web-standalone", capabilityAvailable: false })).toEqual({
      available: false,
      block: "no-host",
      remedy: "/pair",
    })
  })

  it("still says no-host for a standalone browser that somehow reports the capability", () => {
    // A local baseline entry cannot conjure a host. Checking the profile first
    // is what keeps this honest.
    expect(resolveSurfaceReach({ profile: "web-standalone", capabilityAvailable: true })).toEqual({
      available: false,
      block: "no-host",
      remedy: "/pair",
    })
  })

  it("separates 'this machine cannot' from 'the machine you paired to cannot'", () => {
    expect(resolveSurfaceReach({ profile: "desktop", capabilityAvailable: false }).block).toBe(
      "local-lacks-capability"
    )
    expect(
      resolveSurfaceReach({ profile: "mobile-companion", capabilityAvailable: false }).block
    ).toBe("host-lacks-capability")
    expect(
      resolveSurfaceReach({ profile: "cloud-companion", capabilityAvailable: false }).block
    ).toBe("host-lacks-capability")
  })

  it("counts the headless brain as the host, not as a companion", () => {
    // The recurring trap: `!isTauri()` is true under the headless brain, so
    // every hand-rolled version of this check called it a browser.
    expect(resolveSurfaceReach({ profile: "headless", capabilityAvailable: true }).available).toBe(
      true
    )
    expect(resolveSurfaceReach({ profile: "headless", capabilityAvailable: false }).block).toBe(
      "local-lacks-capability"
    )
  })

  it("refuses a desktop-shell requirement everywhere but the desktop", () => {
    expect(
      resolveSurfaceReach({
        profile: "desktop",
        capabilityAvailable: false,
        requirement: "desktop-shell",
      })
    ).toEqual({ available: true })
    for (const profile of ["mobile-companion", "cloud-companion", "headless"] as const) {
      expect(
        resolveSurfaceReach({ profile, capabilityAvailable: true, requirement: "desktop-shell" })
      ).toEqual({ available: false, block: "needs-desktop-shell", remedy: null })
    }
  })

  it("gives a desktop-shell requirement no remedy, because there is none", () => {
    // A phone cannot become a desktop. Offering it a link would make a
    // terminal cause look actionable.
    expect(
      resolveSurfaceReach({
        profile: "mobile-companion",
        capabilityAvailable: true,
        requirement: "desktop-shell",
      }).remedy
    ).toBeNull()
  })

  it("only ever returns a block from the declared vocabulary", () => {
    const profiles = [
      "desktop",
      "mobile-companion",
      "cloud-companion",
      "web-standalone",
      "headless",
    ] as const
    for (const profile of profiles) {
      for (const capabilityAvailable of [true, false]) {
        for (const requirement of ["capability", "desktop-shell"] as const) {
          const reach = resolveSurfaceReach({ profile, capabilityAvailable, requirement })
          if (reach.available) continue
          expect(SURFACE_BLOCKS).toContain(reach.block)
        }
      }
    }
  })
})
