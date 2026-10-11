import {
  GLANCE_MODULE_IDS,
  GLANCE_MODULE_SIZES,
  type GlanceModuleSize,
} from "@/types/glance/layout"

import {
  effectiveSize,
  GLANCE_MODULES,
  glanceModule,
  glanceModulesFor,
  supportsSize,
} from "./registry"

const OWNERS = [
  "fleet",
  "workflows",
  "usage",
  "subscription",
  "scheduler",
  "notifications",
  "connectivity",
  "conversations",
  "pet",
  "tray-actions",
]

describe("GLANCE_MODULES", () => {
  it("has exactly one definition per module id", () => {
    expect(Object.keys(GLANCE_MODULES).sort()).toEqual([...GLANCE_MODULE_IDS].sort())
  })

  it.each(GLANCE_MODULE_IDS.map((id) => [id]))("%s is a complete definition", (id) => {
    const def = GLANCE_MODULES[id]
    expect(def.id).toBe(id)
    expect(def.labelKey.startsWith("modules.")).toBe(true)
    expect(def.labelKey.length).toBeGreaterThan("modules.".length)
    expect(def.icon.length).toBeGreaterThan(0)
    expect(def.slice.length).toBeGreaterThan(0)
    expect(OWNERS).toContain(def.owner)
    expect(typeof def.scopeable).toBe("boolean")
  })

  it.each(GLANCE_MODULE_IDS.map((id) => [id]))("%s lists sizes smallest first", (id) => {
    const { sizes } = GLANCE_MODULES[id]
    expect(sizes.length).toBeGreaterThan(0)
    const ranks = sizes.map((size) => GLANCE_MODULE_SIZES.indexOf(size))
    expect(ranks.every((rank) => rank >= 0)).toBe(true)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(new Set(sizes).size).toBe(sizes.length)
    expect(sizes[0]).toBe("compact")
  })

  it("gives every module a unique label key", () => {
    const keys = GLANCE_MODULE_IDS.map((id) => GLANCE_MODULES[id].labelKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("reads the actions catalogue for quick and a same-named slice otherwise", () => {
    expect(GLANCE_MODULES.quick.slice).toBe("actions")
    for (const id of GLANCE_MODULE_IDS) {
      if (id !== "quick") expect(GLANCE_MODULES[id].slice).toBe(id)
    }
  })
})

describe("platforms", () => {
  it.each(GLANCE_MODULE_IDS.map((id) => [id]))("%s declares at least one known platform", (id) => {
    const { platforms } = GLANCE_MODULES[id]
    expect(platforms.length).toBeGreaterThan(0)
    for (const platform of platforms) expect(["desktop", "mobile"]).toContain(platform)
  })

  it("renders every first-party module on both platforms", () => {
    // `quick` included: each platform fills it from its own action list.
    for (const id of GLANCE_MODULE_IDS) {
      expect(GLANCE_MODULES[id].platforms).toEqual(["desktop", "mobile"])
    }
  })
})

describe("glanceModulesFor", () => {
  it("offers every module on desktop, in catalogue order", () => {
    expect(glanceModulesFor("desktop")).toEqual([...GLANCE_MODULE_IDS])
  })

  it("offers every module on mobile too, in catalogue order", () => {
    expect(glanceModulesFor("mobile")).toEqual([...GLANCE_MODULE_IDS])
  })
})

describe("glanceModule", () => {
  it("returns the definition for a known id", () => {
    expect(glanceModule("fleet")).toBe(GLANCE_MODULES.fleet)
  })

  it.each(["nope", "", "FLEET", "toString", "__proto__", "constructor", "hasOwnProperty"])(
    "returns null for %j",
    (id) => {
      expect(glanceModule(id)).toBeNull()
    }
  )
})

describe("supportsSize", () => {
  it("reflects the declared sizes", () => {
    expect(supportsSize("fleet", "expanded")).toBe(true)
    expect(supportsSize("agenda", "expanded")).toBe(false)
    expect(supportsSize("agenda", "standard")).toBe(true)
  })
})

describe("effectiveSize", () => {
  it("keeps a supported size", () => {
    for (const id of GLANCE_MODULE_IDS) {
      for (const size of GLANCE_MODULES[id].sizes) {
        expect(effectiveSize(id, size)).toBe(size)
      }
    }
  })

  it("degrades expanded to standard on a standard-capped module, not to compact", () => {
    for (const id of ["agenda", "quick", "recents", "pet"] as const) {
      expect(effectiveSize(id, "expanded")).toBe("standard")
    }
  })

  it("never returns a size the module does not support", () => {
    for (const id of GLANCE_MODULE_IDS) {
      for (const size of GLANCE_MODULE_SIZES as readonly GlanceModuleSize[]) {
        expect(supportsSize(id, effectiveSize(id, size))).toBe(true)
      }
    }
  })

  it("falls to the smallest supported size when nothing at or below is supported", () => {
    // No built-in module omits compact, so exercise the fallback by temporarily
    // narrowing a definition to standard-only.
    const def = GLANCE_MODULES.pet
    const original = def.sizes
    ;(def as { sizes: readonly GlanceModuleSize[] }).sizes = ["standard"]
    try {
      expect(effectiveSize("pet", "compact")).toBe("standard")
      expect(effectiveSize("pet", "expanded")).toBe("standard")
    } finally {
      ;(def as { sizes: readonly GlanceModuleSize[] }).sizes = original
    }
  })
})
