import { DEFAULT_TRAY_ITEMS } from "./defaults"

describe("DEFAULT_TRAY_ITEMS", () => {
  it("matches the locked layout shape from the system-tray plan", () => {
    const ids = DEFAULT_TRAY_ITEMS.map((it) => ("id" in it ? it.id : `(sep)`))
    expect(ids).toEqual([
      "tray.show",
      "tray.pet-toggle",
      "tray.pet-disable-click-through",
      "tray.new-chat",
      "tray.quick-goal",
      "tray.sep-1",
      "tray.all-commands",
      "tray.sep-2",
      "tray.settings",
      "tray.open-logs",
      "tray.automation-kill",
      "tray.sep-3",
      "tray.quit",
    ])
  })

  it("references only valid native action ids", () => {
    const validNatives = new Set([
      "show",
      "hide",
      "new-chat",
      "settings",
      "open-logs",
      "automation-kill",
      "pet-toggle",
      "pet-disable-click-through",
      "quit",
    ])
    for (const item of DEFAULT_TRAY_ITEMS) {
      if (item.kind !== "action") continue
      if (item.payload.kind === "native") {
        expect(validNatives.has(item.payload.action)).toBe(true)
      }
    }
  })

  it("contains a single all-commands placeholder ready for the builder to expand", () => {
    const allCmd = DEFAULT_TRAY_ITEMS.find(
      (it) => it.kind === "submenu" && it.id === "tray.all-commands"
    )
    expect(allCmd).toBeDefined()
    if (allCmd && allCmd.kind === "submenu") {
      expect(allCmd.items).toEqual([])
    }
  })

  it("includes the desktop-pet toggle and click-through recovery entries", () => {
    const toggle = DEFAULT_TRAY_ITEMS.find(
      (it) => it.kind === "action" && it.id === "tray.pet-toggle"
    )
    const recover = DEFAULT_TRAY_ITEMS.find(
      (it) => it.kind === "action" && it.id === "tray.pet-disable-click-through"
    )
    expect(toggle).toMatchObject({
      label: "tray.petToggle",
      payload: { kind: "native", action: "pet-toggle" },
    })
    expect(recover).toMatchObject({
      label: "tray.petClickThroughOff",
      payload: { kind: "native", action: "pet-disable-click-through" },
    })
    // The recovery item is unconditional (no `when` gate) so it's always reachable.
    expect((recover as { when?: string }).when).toBeUndefined()
  })

  it("attaches the documented accelerators to the built-in shortcut ids", () => {
    const accelMap: Record<string, string | undefined> = {}
    for (const item of DEFAULT_TRAY_ITEMS) {
      if (item.kind === "action") accelMap[item.id] = item.accelerator
    }
    expect(accelMap["tray.show"]).toBe("Ctrl+Shift+Space")
    expect(accelMap["tray.open-logs"]).toBe("Ctrl+Shift+L")
    expect(accelMap["tray.automation-kill"]).toBe("Ctrl+Alt+K")
  })
})
