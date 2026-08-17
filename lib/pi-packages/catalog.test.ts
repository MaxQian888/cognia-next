import enCatalog from "../../i18n/messages/en/plugins/agentPackages.json"
import zhCatalog from "../../i18n/messages/zh-CN/plugins/agentPackages.json"
import {
  piCatalogEntry,
  piCatalogMessageKey,
  PI_PACKAGE_CATALOG,
  PI_STACK_PRESETS,
} from "./catalog"
import { piPackageIdentity } from "./identity"

/** Both locales' catalog prose, so the parity check can run over each. */
const LOCALES = ["en", "zh-CN"] as const
const CATALOG_MESSAGES: Record<
  (typeof LOCALES)[number],
  { catalog: Record<string, Record<string, string>> }
> = { en: enCatalog, "zh-CN": zhCatalog }

describe("PI_PACKAGE_CATALOG", () => {
  it("has unique ids", () => {
    const ids = PI_PACKAGE_CATALOG.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  /**
   * Two entries resolving to the same Pi identity would make catalog lookup
   * order-dependent — one would silently shadow the other in the conflict and
   * budget views.
   */
  it("has unique Pi identities", () => {
    const identities = PI_PACKAGE_CATALOG.map((e) => piPackageIdentity(e.spec))
    expect(new Set(identities).size).toBe(identities.length)
  })

  it("pins every spec to an exact version", () => {
    // `pi update --extensions` skips exact pins, which is the whole point of
    // recommending them; an unpinned catalog row would drift silently.
    for (const entry of PI_PACKAGE_CATALOG) {
      expect(entry.spec).toMatch(/@[\w.-]+$/)
    }
  })

  it("uses only npm specs, the form the research reviewed", () => {
    for (const entry of PI_PACKAGE_CATALOG) {
      expect(entry.spec.startsWith("npm:")).toBe(true)
    }
  })

  it("gives every entry a review date", () => {
    for (const entry of PI_PACKAGE_CATALOG) {
      expect(entry.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it("never reports a negative or fractional cost", () => {
    for (const entry of PI_PACKAGE_CATALOG) {
      expect(Number.isInteger(entry.staticTokens)).toBe(true)
      expect(entry.staticTokens).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(entry.toolCount)).toBe(true)
      expect(entry.toolCount).toBeGreaterThanOrEqual(0)
    }
  })

  it("charges nothing static to a package that contributes no tools and no injection", () => {
    // The footer packages are the sanity check here: they add no LLM tool, so
    // a non-zero static cost would mean the model is wrong, not the package.
    const statusline = piCatalogEntry("narumitw-pi-statusline")!
    expect(statusline.toolCount).toBe(0)
    expect(statusline.staticTokens).toBe(0)
  })

  it("keeps the always-injected memory package as the most expensive row", () => {
    const worst = [...PI_PACKAGE_CATALOG].sort((a, b) => b.staticTokens - a.staticTokens)[0]
    expect(worst.id).toBe("vtstech-pi-long-term-memory")
    expect(worst.tier).toBe("avoid")
  })

  it("marks only packages that really start new model contexts", () => {
    const spawning = PI_PACKAGE_CATALOG.filter((e) => e.spawnsContexts).map((e) => e.id)
    expect(spawning.sort()).toEqual([
      "gotgenes-pi-subagents",
      "narumitw-pi-goal",
      "narumitw-pi-subagents",
      "narumitw-pi-workflow",
      "pi-subagents",
    ])
  })
})

describe("PI_STACK_PRESETS", () => {
  it("references only ids that exist in the catalog", () => {
    for (const ids of Object.values(PI_STACK_PRESETS)) {
      for (const id of ids) expect(piCatalogEntry(id)).toBeDefined()
    }
  })

  it("never recommends an avoid-tier package", () => {
    for (const ids of Object.values(PI_STACK_PRESETS)) {
      for (const id of ids) expect(piCatalogEntry(id)!.tier).not.toBe("avoid")
    }
  })

  /** Each preset must itself be installable — a self-conflicting one is a bug. */
  it("contains no internal overlap conflicts", () => {
    for (const [name, ids] of Object.entries(PI_STACK_PRESETS)) {
      const seen = new Map<string, string>()
      for (const id of ids) {
        for (const group of piCatalogEntry(id)!.overlapGroups) {
          expect(`${name}:${group}:${seen.get(group) ?? "free"}`).toBe(`${name}:${group}:free`)
          seen.set(group, id)
        }
      }
    }
  })

  it("grows from starter to balanced to power", () => {
    expect(PI_STACK_PRESETS.starter.length).toBeLessThan(PI_STACK_PRESETS.balanced.length)
    expect(PI_STACK_PRESETS.balanced.length).toBeLessThan(PI_STACK_PRESETS.power.length)
  })
})

describe("piCatalogMessageKey", () => {
  it("derives i18n keys mechanically from the id", () => {
    expect(piCatalogMessageKey("pi-mcp-adapter", "summary")).toBe("catalog.pi-mcp-adapter.summary")
    expect(piCatalogMessageKey("pi-mcp-adapter", "risk")).toBe("catalog.pi-mcp-adapter.risk")
  })

  /**
   * `pnpm lint:i18n` cannot check these: the keys are built at runtime from
   * `id`, so it counts them as dynamic references and skips them. This is the
   * only gate that catches a catalog row shipped without prose, which would
   * render as the raw key in the UI.
   */
  it.each(LOCALES)("has prose for every catalog entry in %s", (locale) => {
    const messages = CATALOG_MESSAGES[locale]
    const missing: string[] = []
    for (const entry of PI_PACKAGE_CATALOG) {
      for (const field of ["summary", "risk", "removeWhen"] as const) {
        if (!messages.catalog?.[entry.id]?.[field]?.trim()) {
          missing.push(piCatalogMessageKey(entry.id, field))
        }
      }
    }
    expect(missing).toEqual([])
  })

  /** The inverse: prose for a row that no longer exists is dead weight. */
  it.each(LOCALES)("has no orphaned catalog prose in %s", (locale) => {
    const messages = CATALOG_MESSAGES[locale]
    const ids = new Set(PI_PACKAGE_CATALOG.map((entry) => entry.id))
    expect(Object.keys(messages.catalog).filter((id) => !ids.has(id))).toEqual([])
  })
})

describe("piCatalogEntry", () => {
  it("is undefined for an id that is not in the catalog", () => {
    expect(piCatalogEntry("nope")).toBeUndefined()
  })
})
