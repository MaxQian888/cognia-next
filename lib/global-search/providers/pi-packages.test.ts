import { PI_PACKAGE_CATALOG, type PiCatalogEntry } from "@/lib/pi-packages/catalog"
import type { GlobalSearchContext, ParsedGlobalSearchQuery } from "../types"
import { createPiPackagesProvider } from "./pi-packages"

function ctx(): GlobalSearchContext {
  return {
    // Echo the key so assertions can check *which* key a row asked for without
    // depending on the English wording.
    t: (key: string) => key,
    now: 1_000,
  } as unknown as GlobalSearchContext
}

function query(needle: string): ParsedGlobalSearchQuery {
  return { needle, raw: needle } as unknown as ParsedGlobalSearchQuery
}

async function search(needle: string, isDesktop = true) {
  const provider = createPiPackagesProvider({ isDesktop: () => isDesktop })
  return provider.search({
    query: query(needle),
    ctx: ctx(),
    limit: 20,
    signal: new AbortController().signal,
  })
}

describe("piPackagesProvider", () => {
  it("matches a package by its short name", async () => {
    const { items } = await search("memory")
    expect(items.map((item) => item.id)).toContain("pi-package:pi-memory")
  })

  it("matches by catalog id and by overlap group", async () => {
    expect((await search("mcp-adapter")).items.length).toBeGreaterThan(0)
    expect((await search("subagents")).items.length).toBeGreaterThan(0)
  })

  it("titles rows by short name, keeping the npm scope", async () => {
    const { items } = await search("narumitw/pi-subagents")
    expect(items[0].title).toBe("@narumitw/pi-subagents")
  })

  /**
   * The palette must not install on Enter: it stages the spec and lets the
   * section open its own pre-install gate, which is where the overlap and
   * budget warnings live. Pi itself never warns, so skipping that is the whole
   * failure mode.
   */
  it("emits an install action carrying the pinned spec, not a raw navigate", async () => {
    const { items } = await search("pi-memory")
    expect(items[0].action).toEqual({
      type: "install",
      target: "pi-package",
      spec: "npm:pi-memory@0.4.2",
    })
  })

  it("shows the always-on cost in the row meta", async () => {
    const { items } = await search("pi-memory")
    expect(items[0].meta).toBe("globalSearch.piPackages.cost")
  })

  it("says so when a package has no always-on cost", async () => {
    const { items } = await search("statusline")
    expect(items[0].meta).toBe("globalSearch.piPackages.free")
  })

  it("marks avoid-tier rows instead of showing them as ordinary", async () => {
    const { items } = await search("finish-notification")
    expect(items[0].meta).toBe("globalSearch.piPackages.avoid")
    expect(items[0].extra?.disabledReason).toBe("globalSearch.piPackages.avoid")
  })

  it("uses the catalog's own prose key for the subtitle", async () => {
    const { items } = await search("pi-memory")
    expect(items[0].subtitle).toBe("plugins.agentPackages.catalog.pi-memory.summary")
  })

  /** Pi's package system needs a config file and a CLI; neither exists on web. */
  it("returns nothing outside the desktop shell", async () => {
    const { items } = await search("memory", false)
    expect(items).toEqual([])
  })

  it("returns nothing for a needle that matches no package", async () => {
    const { items } = await search("zzzznotapackage")
    expect(items).toEqual([])
  })
})

describe("piPackagesProvider suggestions", () => {
  async function suggest(limit = 5) {
    const provider = createPiPackagesProvider({ isDesktop: () => true })
    // `suggest` takes `Omit<GlobalSearchProviderInput, "query">` — the empty-query
    // surface has no query by definition.
    return provider.suggest!({
      ctx: ctx(),
      limit,
      signal: new AbortController().signal,
    })
  }

  /** Offering an avoid-tier row unprompted would be recommending it. */
  it("suggests only core-tier packages", async () => {
    const items = await suggest(20)
    const coreIds = new Set(
      PI_PACKAGE_CATALOG.filter((entry: PiCatalogEntry) => entry.tier === "core").map(
        (entry) => `pi-package:${entry.id}`
      )
    )
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) expect(coreIds.has(item.id)).toBe(true)
  })

  it("honours the limit", async () => {
    expect(await suggest(3)).toHaveLength(3)
  })

  it("suggests in catalog order, so the ranking survives", async () => {
    const items = await suggest(2)
    expect(items[0].id).toBe("pi-package:aliou-pi-guardrails")
    expect(items[1].id).toBe("pi-package:narumitw-pi-statusline")
  })

  it("gives suggestions the same install action as search hits", async () => {
    const [first] = await suggest(1)
    expect(first.action).toMatchObject({ type: "install", target: "pi-package" })
  })
})
