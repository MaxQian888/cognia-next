import { DEFAULT_TRAY_DISPLAY, DEFAULT_TRAY_ITEMS } from "./defaults"
import { NATIVE_TRAY_ACTIONS } from "./native-actions"

describe("DEFAULT_TRAY_ITEMS", () => {
  it("matches the locked layout shape from the system-tray plan", () => {
    const ids = DEFAULT_TRAY_ITEMS.map((it) => ("id" in it ? it.id : `(sep)`))
    expect(ids).toEqual([
      "tray.status",
      "tray.sep-0",
      "tray.show",
      "tray.panel-toggle",
      "tray.pet-toggle",
      "tray.pet-disable-click-through",
      "tray.island-toggle",
      "tray.pet",
      "tray.new-chat",
      "tray.quick-goal",
      "tray.sep-1",
      "tray.usage",
      "tray.all-commands",
      "tray.sep-2",
      "tray.autostart",
      "tray.settings",
      "tray.open-logs",
      "tray.automation-kill",
      "tray.sep-3",
      "tray.about",
      "tray.sep-4",
      "tray.quit",
    ])
  })

  it("references only valid native action ids", () => {
    // Read from the shared table rather than a second hand-maintained copy:
    // `native-actions.ts` is itself pinned against the Rust whitelist, so an
    // action added there can never silently drift out of sync here.
    const validNatives = new Set<string>(NATIVE_TRAY_ACTIONS)
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

  it("contains an empty usage placeholder for the builder to expand", () => {
    const usage = DEFAULT_TRAY_ITEMS.find((it) => it.kind === "submenu" && it.id === "tray.usage")
    expect(usage).toBeDefined()
    if (usage && usage.kind === "submenu") {
      expect(usage.items).toEqual([])
      expect(usage.label).toBe("tray.usage.title")
    }
  })

  it("ships conservative display defaults — menu on, glanceable surfaces off", () => {
    expect(DEFAULT_TRAY_DISPLAY).toEqual({
      showUsageInMenu: true,
      showUsageInTooltip: false,
      taskbarUsageMode: "off",
      usageAccountKey: null,
      usageRefreshMinutes: 15,
      iconColor: "#000000",
      usageMetric: "quota",
      usagePeriod: "today",
      usageScope: "cognia",
    })
  })

  it("defaults the spend surfaces to the behaviour that existed before them", () => {
    // Quota is what a configured taskbar readout already showed, and the
    // Cognia scope is the one that performs no filesystem scanning. An upgrade
    // must not change a single number the user was already looking at, nor
    // start reading other tools' transcripts without being asked.
    expect(DEFAULT_TRAY_DISPLAY.usageMetric).toBe("quota")
    expect(DEFAULT_TRAY_DISPLAY.usageScope).toBe("cognia")
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

  it("gates the pet quick-actions submenu on pet.enabled and dispatches through the shared commands", () => {
    const submenu = DEFAULT_TRAY_ITEMS.find((it) => it.kind === "submenu" && it.id === "tray.pet")
    expect(submenu).toBeDefined()
    if (!submenu || submenu.kind !== "submenu") return
    expect(submenu.when).toBe("pet.enabled")
    const ids = submenu.items.map((it) => it.id)
    expect(ids).toEqual([
      "tray.pet.feed",
      "tray.pet.play",
      "tray.pet.pet",
      "tray.pet.sleep",
      "tray.pet.clean",
      "tray.pet.treat",
      "tray.pet.sep-0",
      "tray.pet.settings",
    ])
    const commandIds = submenu.items
      .filter((it) => it.kind === "action" && it.payload.kind === "command")
      .map((it) =>
        it.kind === "action" && it.payload.kind === "command" ? it.payload.commandId : ""
      )
    expect(commandIds).toEqual([
      "pet.feed",
      "pet.play",
      "pet.pet",
      "pet.sleep",
      "pet.clean",
      "pet.treat",
    ])
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
