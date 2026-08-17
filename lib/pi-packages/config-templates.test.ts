import { PI_PACKAGE_CATALOG } from "./catalog"
import {
  PI_CONFIG_TEMPLATES,
  piConfigBasename,
  piConfigPath,
  piConfigTemplateFor,
} from "./config-templates"

describe("piConfigBasename", () => {
  it("drops the scope and the version pin", () => {
    expect(piConfigBasename("npm:@narumitw/pi-statusline@0.49.6")).toBe("pi-statusline")
  })

  it("handles an unscoped name", () => {
    expect(piConfigBasename("npm:pi-memory@0.4.2")).toBe("pi-memory")
  })

  it("handles a name with no pin", () => {
    expect(piConfigBasename("npm:pi-memory")).toBe("pi-memory")
  })

  /** Git and local specs have no npm name to derive a file name from. */
  it("returns null for non-npm specs", () => {
    expect(piConfigBasename("git:github.com/o/r")).toBeNull()
    expect(piConfigBasename("./local-ext")).toBeNull()
  })
})

describe("piConfigTemplateFor", () => {
  it("returns the reviewed statusline defaults", () => {
    const template = piConfigTemplateFor("npm:@narumitw/pi-statusline@0.49.6") as {
      segments: string[]
    }
    expect(template.segments).toContain("cost")
  })

  /**
   * The one name that is not derivable: the package is `pi-permission-modes`
   * but the file it writes is `permission-mode.json`.
   */
  it("maps pi-permission-modes to permission-mode", () => {
    expect(piConfigTemplateFor("npm:pi-permission-modes@2.2.0")).not.toBeNull()
    expect(piConfigPath("/home/u/.pi/agent", "npm:pi-permission-modes@2.2.0")).toBe(
      "/home/u/.pi/agent/permission-mode.json"
    )
  })

  it("returns null for a package with no reviewed defaults", () => {
    expect(piConfigTemplateFor("npm:pi-atelier@0.8.1")).toBeNull()
  })

  it("returns null for a non-npm spec", () => {
    expect(piConfigTemplateFor("./local")).toBeNull()
  })
})

describe("piConfigPath", () => {
  it("joins onto the resolved agent dir, tolerating a trailing slash", () => {
    expect(piConfigPath("/home/u/.pi/agent/", "npm:pi-goal")).toBe("/home/u/.pi/agent/pi-goal.json")
  })

  it("returns null when there is no basename to use", () => {
    expect(piConfigPath("/home/u/.pi/agent", "git:github.com/o/r")).toBeNull()
  })
})

describe("PI_CONFIG_TEMPLATES", () => {
  /**
   * Every template must belong to a package we actually recommend, or it is
   * advice for something the UI never offers.
   */
  it("only carries defaults for catalogued packages", () => {
    const catalogued = new Set(
      PI_PACKAGE_CATALOG.map((entry) => {
        const basename = piConfigBasename(entry.spec)
        return basename === "pi-permission-modes" ? "permission-mode" : basename
      }).filter((name): name is string => name !== null)
    )
    for (const key of Object.keys(PI_CONFIG_TEMPLATES)) {
      expect(catalogued.has(key)).toBe(true)
    }
  })

  it("keeps the subagents stateful section present but off", () => {
    const template = PI_CONFIG_TEMPLATES["pi-subagents"] as {
      blocking: { enabled: boolean }
      stateful: { enabled: boolean; maxDepth: number }
    }
    expect(template.blocking.enabled).toBe(true)
    expect(template.stateful.enabled).toBe(false)
    expect(template.stateful.maxDepth).toBe(1)
  })

  /**
   * The recommended power stack installs both permission-modes and the
   * standalone plan package. Leaving `plan` in `cycleOrder` would give two
   * owners to one mode — and it is also what keeps YOLO out of the cycle.
   */
  it("omits plan from the permission-mode cycle", () => {
    const template = PI_CONFIG_TEMPLATES["permission-mode"] as { cycleOrder: string[] }
    expect(template.cycleOrder).toEqual(["default", "build"])
    expect(template.cycleOrder).not.toContain("plan")
    expect(template.cycleOrder).not.toContain("yolo")
  })

  it("caps goal continuation rather than leaving it unbounded", () => {
    const template = PI_CONFIG_TEMPLATES["pi-goal"] as {
      continuationLimits: { automaticTurns: number; noProgressTurns: number }
    }
    expect(template.continuationLimits.automaticTurns).toBeLessThanOrEqual(12)
    expect(template.continuationLimits.noProgressTurns).toBeLessThanOrEqual(3)
  })
})
