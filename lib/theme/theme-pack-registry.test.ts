import {
  __resetThemePackRegistryForTesting,
  getThemePack,
  hasThemePackKey,
  listThemePackKeys,
  listThemePacks,
  registerThemePack,
  subscribeThemePackRegistry,
  unregisterThemePack,
  unregisterThemePacksByPlugin,
} from "./theme-pack-registry"
import type { PluginThemePackContribution } from "@/types/plugin/plugin"

function packFixture(
  id: string,
  overrides: Partial<PluginThemePackContribution> = {}
): PluginThemePackContribution {
  return {
    id,
    name: `pack-${id}`,
    applies: { themeId: `${id}-theme` },
    ...overrides,
  }
}

beforeEach(() => {
  __resetThemePackRegistryForTesting()
})

describe("registerThemePack", () => {
  it("registers a new pack and surfaces it in the snapshot", () => {
    registerThemePack({ pluginId: "p1", pluginName: "Plugin One", pack: packFixture("light") })
    const list = listThemePacks()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe("light")
    expect(list[0].pluginId).toBe("p1")
    expect(list[0].pluginName).toBe("Plugin One")
  })

  it("returns replaced=true on overwrite", () => {
    registerThemePack({ pluginId: "p1", pack: packFixture("a") })
    const out = registerThemePack({ pluginId: "p1", pack: packFixture("a", { name: "new" }) })
    expect(out.replaced).toBe(true)
    expect(getThemePack("p1", "a")?.name).toBe("new")
  })

  it("rejects packs without an id", () => {
    expect(() =>
      registerThemePack({ pluginId: "p", pack: { ...packFixture("x"), id: "" } })
    ).toThrow(/id is required/)
  })

  it("allows the same pack id under two different plugins", () => {
    registerThemePack({ pluginId: "p1", pack: packFixture("light") })
    registerThemePack({ pluginId: "p2", pack: packFixture("light") })
    expect(listThemePacks()).toHaveLength(2)
  })
})

describe("unregister", () => {
  it("unregisterThemePack removes a single pack", () => {
    registerThemePack({ pluginId: "p1", pack: packFixture("a") })
    expect(unregisterThemePack("p1", "a")).toBe(true)
    expect(listThemePacks()).toHaveLength(0)
  })

  it("unregisterThemePack returns false when missing", () => {
    expect(unregisterThemePack("p1", "ghost")).toBe(false)
  })

  it("unregisterThemePacksByPlugin removes every pack owned by the plugin", () => {
    registerThemePack({ pluginId: "p1", pack: packFixture("a") })
    registerThemePack({ pluginId: "p1", pack: packFixture("b") })
    registerThemePack({ pluginId: "p2", pack: packFixture("a") })
    expect(unregisterThemePacksByPlugin("p1")).toBe(2)
    expect(listThemePacks()).toHaveLength(1)
    expect(listThemePacks()[0].pluginId).toBe("p2")
  })

  it("returns 0 + no notify when nothing to remove", () => {
    const fires: number[] = []
    subscribeThemePackRegistry(() => fires.push(0))
    expect(unregisterThemePacksByPlugin("ghost")).toBe(0)
    expect(fires).toHaveLength(0)
  })
})

describe("Character Pack dependency keys", () => {
  it("lists and resolves canonical pluginId.packId keys", () => {
    registerThemePack({ pluginId: "p1", pack: packFixture("light") })
    registerThemePack({ pluginId: "p2", pack: packFixture("light") })

    expect(listThemePackKeys()).toEqual(["p1.light", "p2.light"])
    expect(hasThemePackKey("p1.light")).toBe(true)
    expect(hasThemePackKey("p2.light")).toBe(true)
    expect(hasThemePackKey("light")).toBe(false)
    expect(hasThemePackKey("p1.dark")).toBe(false)
  })

  it("drops keys when a pack is removed or the test registry resets", () => {
    registerThemePack({ pluginId: "p1", pack: packFixture("light") })
    expect(unregisterThemePack("p1", "light")).toBe(true)
    expect(hasThemePackKey("p1.light")).toBe(false)

    registerThemePack({ pluginId: "p1", pack: packFixture("dark") })
    __resetThemePackRegistryForTesting()
    expect(listThemePackKeys()).toEqual([])
    expect(hasThemePackKey("p1.dark")).toBe(false)
  })
})

describe("subscribe", () => {
  it("listener fires on register / unregister and unsubscribe stops it", () => {
    const fires: number[] = []
    const unsub = subscribeThemePackRegistry(() => fires.push(listThemePacks().length))
    registerThemePack({ pluginId: "p1", pack: packFixture("a") })
    unregisterThemePack("p1", "a")
    unsub()
    registerThemePack({ pluginId: "p1", pack: packFixture("b") })
    expect(fires).toEqual([1, 0])
  })

  it("snapshot identity stays stable until the next mutation", () => {
    const a = listThemePacks()
    const b = listThemePacks()
    expect(a).toBe(b)
    registerThemePack({ pluginId: "p1", pack: packFixture("x") })
    const c = listThemePacks()
    expect(c).not.toBe(a)
  })
})
