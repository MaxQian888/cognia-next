import {
  isPetAvailable,
  resolveLivePetAvailability,
  resolvePetAvailability,
  type PetAvailabilityInput,
} from "./availability"

const base: PetAvailabilityInput = { enabled: true, role: "main", platform: "tauri" }

describe("resolvePetAvailability", () => {
  it("allows the enabled pet in the main desktop window", () => {
    expect(resolvePetAvailability(base)).toEqual({ available: true })
  })

  it("allows the enabled pet on the web", () => {
    expect(resolvePetAvailability({ ...base, role: "web", platform: "web" })).toEqual({
      available: true,
    })
  })

  it("refuses when the user turned the pet off", () => {
    expect(resolvePetAvailability({ ...base, enabled: false })).toEqual({
      available: false,
      reason: "disabled",
    })
  })

  it("refuses on the mobile shell even when enabled", () => {
    expect(resolvePetAvailability({ ...base, role: "web", platform: "mobile" })).toEqual({
      available: false,
      reason: "unsupported-host",
    })
  })

  it.each(["overlay", "popup", "island", "selection-toolbar", "tray-panel", "usage-dock"] as const)(
    "refuses in the secondary window %s, which must never award XP",
    (role) => {
      expect(resolvePetAvailability({ ...base, role })).toEqual({
        available: false,
        reason: "secondary-window",
      })
    }
  )

  it("reports the structural reason before the setting", () => {
    // Both are true. The overlay window can never run the controller, so that
    // is the reason a caller can act on, and flipping `enabled` would not
    // change the answer.
    expect(resolvePetAvailability({ enabled: false, role: "overlay", platform: "tauri" })).toEqual({
      available: false,
      reason: "secondary-window",
    })
    expect(resolvePetAvailability({ enabled: false, role: "web", platform: "mobile" })).toEqual({
      available: false,
      reason: "unsupported-host",
    })
  })
})

describe("isPetAvailable", () => {
  it("collapses the decision to a boolean", () => {
    expect(isPetAvailable(base)).toBe(true)
    expect(isPetAvailable({ ...base, enabled: false })).toBe(false)
  })
})

describe("resolveLivePetAvailability", () => {
  it("honours injected role and platform without touching the environment", () => {
    expect(resolveLivePetAvailability(true, { role: "main", platform: "tauri" })).toEqual({
      available: true,
    })
    expect(resolveLivePetAvailability(true, { role: "overlay", platform: "tauri" })).toEqual({
      available: false,
      reason: "secondary-window",
    })
  })

  it("still reports the setting when the environment is fine", () => {
    expect(resolveLivePetAvailability(false, { role: "main", platform: "tauri" })).toEqual({
      available: false,
      reason: "disabled",
    })
  })
})
