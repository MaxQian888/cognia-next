jest.mock("@/lib/tauri/store", () => ({
  getPref: jest.fn(),
  setPref: jest.fn(() => Promise.resolve()),
}))
jest.mock("@cognia/logging", () => ({
  loggers: { tray: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } },
}))

import { getPref, setPref } from "@/lib/tauri/store"

import {
  DEFAULT_TRAY_DISPLAY,
  DEFAULT_TRAY_ITEMS,
  TRAY_DISPLAY_PREF,
  TRAY_LAYOUT_PREF,
} from "./defaults"
import {
  ensureSyntheticEntries,
  migrateRetiredNativePayloads,
  useTrayStore,
  __resetTrayStoreForTesting,
} from "./store"
import type { TrayMenuItem } from "./types"

const getPrefMock = getPref as jest.Mock
const setPrefMock = setPref as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  __resetTrayStoreForTesting()
  getPrefMock.mockResolvedValue(undefined)
})

describe("ensureSyntheticEntries", () => {
  it("backfills the usage placeholder into pre-existing layouts at its default position", () => {
    const legacy = DEFAULT_TRAY_ITEMS.filter((it) => !("id" in it) || it.id !== "tray.usage")
    const repaired = ensureSyntheticEntries(legacy)
    const ids = repaired.map((it) => ("id" in it ? it.id : "(sep)"))
    expect(ids).toContain("tray.usage")
    // Same slot it holds in the locked default layout.
    expect(ids.indexOf("tray.usage")).toBe(
      DEFAULT_TRAY_ITEMS.findIndex((it) => "id" in it && it.id === "tray.usage")
    )
  })

  it("leaves layouts that already carry the placeholder untouched", () => {
    expect(ensureSyntheticEntries(DEFAULT_TRAY_ITEMS)).toBe(DEFAULT_TRAY_ITEMS)
  })

  it("clamps the insert position for short custom layouts", () => {
    const tiny: TrayMenuItem[] = [
      { kind: "action", id: "only", label: "only", payload: { kind: "native", action: "show" } },
    ]
    const repaired = ensureSyntheticEntries(tiny)
    expect(repaired.map((it) => ("id" in it ? it.id : ""))).toEqual(["only", "tray.usage"])
  })
})

describe("migrateRetiredNativePayloads", () => {
  // A layout persisted before `pet-toggle` was retired. Typed loosely on
  // purpose: the union no longer admits the old action, but stored JSON can.
  const legacyToggle = {
    kind: "action",
    id: "tray.pet-toggle",
    label: "tray.petToggle",
    iconHint: "pet",
    payload: { kind: "native", action: "pet-toggle" },
  } as unknown as TrayMenuItem

  it("rewrites a retired native payload into its command, keeping the rest", () => {
    const [migrated] = migrateRetiredNativePayloads([legacyToggle])
    expect(migrated).toEqual({
      kind: "action",
      id: "tray.pet-toggle",
      label: "tray.petToggle",
      iconHint: "pet",
      payload: { kind: "command", commandId: "pet.toggle-window" },
    })
  })

  it("reaches into submenus", () => {
    const layout = [
      { kind: "submenu", id: "tray.mine", label: "Mine", items: [legacyToggle] },
    ] as TrayMenuItem[]
    const out = migrateRetiredNativePayloads(layout)
    const sub = out[0] as Extract<TrayMenuItem, { kind: "submenu" }>
    expect(sub.items[0]).toMatchObject({
      payload: { kind: "command", commandId: "pet.toggle-window" },
    })
  })

  it("returns the same reference when nothing is retired", () => {
    expect(migrateRetiredNativePayloads(DEFAULT_TRAY_ITEMS)).toBe(DEFAULT_TRAY_ITEMS)
  })

  it("leaves live native actions alone", () => {
    const recover = DEFAULT_TRAY_ITEMS.find(
      (it) => "id" in it && it.id === "tray.pet-disable-click-through"
    )!
    expect(migrateRetiredNativePayloads([recover])[0]).toBe(recover)
  })

  it("is applied at hydrate, before the synthetic backfill", async () => {
    // No usage placeholder AND a retired action: both repairs must land.
    const legacy = [legacyToggle]
    getPrefMock.mockImplementation((key: string) =>
      Promise.resolve(key === TRAY_LAYOUT_PREF ? legacy : undefined)
    )
    await useTrayStore.getState().hydrate()
    const items = useTrayStore.getState().items
    expect(items.find((it) => "id" in it && it.id === "tray.pet-toggle")).toMatchObject({
      payload: { kind: "command", commandId: "pet.toggle-window" },
    })
    expect(items.some((it) => "id" in it && it.id === "tray.usage")).toBe(true)
  })
})

describe("display prefs", () => {
  it("hydrates stored display prefs merged over defaults", async () => {
    getPrefMock.mockImplementation((key: string) =>
      Promise.resolve(key === TRAY_DISPLAY_PREF ? { taskbarUsageMode: "iconBadge" } : undefined)
    )
    await useTrayStore.getState().hydrate()
    expect(useTrayStore.getState().display).toEqual({
      ...DEFAULT_TRAY_DISPLAY,
      taskbarUsageMode: "iconBadge",
    })
  })

  it("setDisplay merges the patch and persists the full prefs blob", () => {
    useTrayStore.getState().setDisplay({ usageAccountKey: "anthropic:a1" })
    expect(useTrayStore.getState().display.usageAccountKey).toBe("anthropic:a1")
    expect(useTrayStore.getState().display.showUsageInMenu).toBe(true)
    expect(setPrefMock).toHaveBeenCalledWith(TRAY_DISPLAY_PREF, {
      ...DEFAULT_TRAY_DISPLAY,
      usageAccountKey: "anthropic:a1",
    })
  })

  it("reset restores the display defaults alongside layout and tooltip", () => {
    useTrayStore.getState().setDisplay({ showUsageInTooltip: true })
    useTrayStore.getState().reset()
    expect(useTrayStore.getState().display).toEqual(DEFAULT_TRAY_DISPLAY)
    expect(setPrefMock).toHaveBeenCalledWith(TRAY_DISPLAY_PREF, DEFAULT_TRAY_DISPLAY)
    expect(setPrefMock).toHaveBeenCalledWith(TRAY_LAYOUT_PREF, DEFAULT_TRAY_ITEMS)
  })

  it("hydrate repairs legacy layouts missing the usage placeholder", async () => {
    const legacy = DEFAULT_TRAY_ITEMS.filter((it) => !("id" in it) || it.id !== "tray.usage")
    getPrefMock.mockImplementation((key: string) =>
      Promise.resolve(key === TRAY_LAYOUT_PREF ? legacy : undefined)
    )
    await useTrayStore.getState().hydrate()
    const ids = useTrayStore.getState().items.map((it) => ("id" in it ? it.id : "(sep)"))
    expect(ids).toContain("tray.usage")
  })

  it("hydrate falls back to defaults (but still flips hydrated) when prefs are unreadable", async () => {
    getPrefMock.mockRejectedValue(new Error("store corrupted"))
    await useTrayStore.getState().hydrate()
    expect(useTrayStore.getState().hydrated).toBe(true)
    expect(useTrayStore.getState().display).toEqual(DEFAULT_TRAY_DISPLAY)
    expect(useTrayStore.getState().items).toEqual(DEFAULT_TRAY_ITEMS)
  })
})
