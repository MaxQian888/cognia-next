import { PET_CONSOLE_TABS } from "@/lib/pet/console-tabs"
import {
  PET_CONSOLE_CAPABILITIES,
  PET_CONSOLE_CAPABILITY_IDS,
  petConsoleCapability,
  petConsoleDesktopOnlyTabs,
  petConsoleTabCapability,
} from "./action-capabilities"

describe("pet console capabilities (ADR-0219)", () => {
  it("classifies every capability exactly once", () => {
    expect(Object.keys(PET_CONSOLE_CAPABILITIES).sort()).toEqual(
      [...PET_CONSOLE_CAPABILITY_IDS].sort()
    )
  })

  it("has a capability for every console tab", () => {
    for (const tab of PET_CONSOLE_TABS) {
      expect(PET_CONSOLE_CAPABILITY_IDS).toContain(petConsoleTabCapability(tab))
    }
  })

  it("gives the desktop console every capability", () => {
    for (const id of PET_CONSOLE_CAPABILITY_IDS) {
      expect(petConsoleCapability("local", id)).toBe("available")
    }
  })

  // The dormancy pin (CLAUDE.md rule 7): exactly these stay on the desktop. A
  // change here must come with the UI that labels it.
  it("keeps exactly the desktop-owned capabilities on the desktop in remote mode", () => {
    const desktopOnly = PET_CONSOLE_CAPABILITY_IDS.filter(
      (id) => petConsoleCapability("remote", id) === "desktop-only"
    )
    expect(desktopOnly.sort()).toEqual(
      [
        "binding.edit",
        "chat.enable",
        "desktop.toggle",
        "reset",
        "skin.configure",
        "skin.retry",
        "tab.customize",
        "tab.insights",
        "tab.plugins",
      ].sort()
    )
  })

  it("keeps the care loop and the records available remotely", () => {
    for (const id of [
      "care",
      "shop.purchase",
      "item.use",
      "item.applyDecor",
      "rename",
      "hatch",
      "chat.send",
      "chat.clear",
      "tab.journal",
      "tab.dex",
      "tab.achievements",
      "tab.binding",
    ] as const) {
      expect(petConsoleCapability("remote", id)).toBe("available")
    }
  })

  it("lists the tabs that render the desktop-only notice", () => {
    expect([...petConsoleDesktopOnlyTabs("remote", PET_CONSOLE_TABS)].sort()).toEqual([
      "customize",
      "insights",
      "plugins",
    ])
    expect(petConsoleDesktopOnlyTabs("local", PET_CONSOLE_TABS).size).toBe(0)
    // Only among the tabs the console offers.
    expect([...petConsoleDesktopOnlyTabs("remote", ["nurture", "customize"])]).toEqual([
      "customize",
    ])
  })
})
