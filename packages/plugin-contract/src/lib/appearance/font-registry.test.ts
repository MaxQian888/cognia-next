import {
  __resetFontRegistryForTesting,
  findFont,
  listFonts,
  registerPluginFont,
  setSystemFonts,
  subscribeFonts,
  unregisterPluginFontsByPlugin,
} from "./font-registry"

beforeEach(() => {
  __resetFontRegistryForTesting()
})

describe("listFonts (baseline)", () => {
  it("ships at least the canonical web-safe families", () => {
    const fonts = listFonts()
    const names = fonts.map((f) => f.family)
    expect(names).toEqual(expect.arrayContaining(["system-ui", "monospace", "sans-serif", "serif"]))
  })

  it("every web-safe entry carries source 'websafe'", () => {
    for (const entry of listFonts()) {
      expect(entry.source).toBe("websafe")
    }
  })
})

describe("setSystemFonts", () => {
  it("adds system entries after the web-safe block", () => {
    setSystemFonts(["Inter", "JetBrains Mono"])
    const fonts = listFonts()
    const inter = fonts.find((f) => f.family === "Inter")
    expect(inter?.source).toBe("system")
    // Web-safe entries still present.
    expect(fonts.find((f) => f.family === "monospace")?.source).toBe("websafe")
  })

  it("dedupes + sorts the system list", () => {
    setSystemFonts(["B", "A", "A", "C"])
    const systemFonts = listFonts()
      .filter((f) => f.source === "system")
      .map((f) => f.family)
    expect(systemFonts).toEqual(["A", "B", "C"])
  })

  it("is idempotent — same list does not re-emit", () => {
    const seen: number[] = []
    subscribeFonts(() => seen.push(listFonts().length))
    setSystemFonts(["A"])
    setSystemFonts(["A"])
    expect(seen).toHaveLength(1)
  })

  it("carries the monospaced flag from object-form entries", () => {
    // Use families that don't collide with the web-safe block (which has no
    // monospaced flag and sorts ahead of system entries).
    setSystemFonts([
      { family: "JetBrains Mono", monospaced: true },
      { family: "Helvetica Neue", monospaced: false },
    ])
    const system = listFonts().filter((f) => f.source === "system")
    expect(system.find((f) => f.family === "JetBrains Mono")?.monospaced).toBe(true)
    expect(system.find((f) => f.family === "Helvetica Neue")?.monospaced).toBe(false)
  })

  it("OR-reduces monospaced across duplicate families", () => {
    setSystemFonts([
      { family: "Iosevka", monospaced: false },
      { family: "Iosevka", monospaced: true },
    ])
    const iosevka = listFonts().filter((f) => f.family === "Iosevka")
    expect(iosevka).toHaveLength(1)
    expect(iosevka[0]!.monospaced).toBe(true)
  })

  it("plain string entries default to monospaced=false", () => {
    setSystemFonts(["Plain Family"])
    expect(listFonts().find((f) => f.family === "Plain Family")?.monospaced).toBe(false)
  })

  it("re-emits when only the monospaced flag changes", () => {
    const seen: number[] = []
    setSystemFonts([{ family: "X", monospaced: false }])
    subscribeFonts(() => seen.push(listFonts().length))
    setSystemFonts([{ family: "X", monospaced: true }])
    expect(seen).toHaveLength(1)
  })
})

describe("registerPluginFont", () => {
  it("registers and lists with plugin source", () => {
    registerPluginFont("pluginA", "Cascadia Code")
    const entry = findFont("Cascadia Code")
    expect(entry?.source).toBe("plugin")
    expect(entry?.pluginId).toBe("pluginA")
  })

  it("dedupes same family from same plugin", () => {
    const seen: number[] = []
    subscribeFonts(() => seen.push(listFonts().length))
    registerPluginFont("pluginA", "Inter")
    registerPluginFont("pluginA", "Inter")
    expect(seen).toHaveLength(1)
  })

  it("allows the same family from two different plugins", () => {
    registerPluginFont("pluginA", "Inter")
    registerPluginFont("pluginB", "Inter")
    const interEntries = listFonts().filter((f) => f.family === "Inter")
    // Both registered; the snapshot lists them once per pluginId.
    expect(interEntries.length).toBeGreaterThanOrEqual(2)
  })
})

describe("unregisterPluginFontsByPlugin", () => {
  it("removes only the named plugin's entries", () => {
    registerPluginFont("pluginA", "FamA")
    registerPluginFont("pluginB", "FamB")
    const removed = unregisterPluginFontsByPlugin("pluginA")
    expect(removed).toBe(1)
    expect(findFont("FamA")).toBeUndefined()
    expect(findFont("FamB")?.pluginId).toBe("pluginB")
  })

  it("returns 0 when nothing to remove (no emit)", () => {
    const seen: number[] = []
    subscribeFonts(() => seen.push(0))
    expect(unregisterPluginFontsByPlugin("ghost")).toBe(0)
    expect(seen).toHaveLength(0)
  })
})

describe("subscription", () => {
  it("listener fires on every change, and unsubscribe stops it", () => {
    const seen: number[] = []
    const unsub = subscribeFonts(() => seen.push(listFonts().length))
    registerPluginFont("p", "A")
    setSystemFonts(["B"])
    unsub()
    registerPluginFont("p", "C") // should not notify after unsub
    expect(seen).toHaveLength(2)
  })
})
