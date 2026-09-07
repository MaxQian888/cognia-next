import {
  buildBotCatalog,
  catalogEntryInstallable,
  filterBotCatalog,
  matchesCatalogSearch,
  type BotCatalogEntry,
} from "./catalog"
import type { BotDefinitionRow, BotInstallationRow } from "@/lib/db/bot-types"
import type { RegisteredBot } from "@/lib/plugin/registries/bot-registry"

function registered(
  id: string,
  overrides: Partial<RegisteredBot["definition"]> = {},
  handler?: RegisteredBot["handler"]
): { id: string; entry: RegisteredBot; pluginId?: string } {
  return {
    id,
    pluginId: id.split(":")[0],
    entry: {
      id,
      definition: {
        id: id.split(":")[1] ?? id,
        name: "Digest",
        version: "1.0.0",
        executor: "workflow",
        workflow: "wf_1",
        triggers: [{ id: "cron", kind: "schedule", cron: "0 9 * * *" }],
        ...overrides,
      } as RegisteredBot["definition"],
      ...(handler ? { handler } : {}),
    },
  }
}

function localRow(overrides: Partial<BotDefinitionRow> = {}): BotDefinitionRow {
  return {
    id: "bdef_1",
    name: "Local digest",
    version: "0.1.0",
    executor: "agent-turn",
    prompt: "summarise",
    triggers: [{ id: "manual", kind: "manual" }],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function installation(definitionId: string, id = `boti_${definitionId}`): BotInstallationRow {
  return {
    id,
    definitionId,
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    status: "enabled",
    config: {},
    credentialBindings: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("buildBotCatalog", () => {
  it("enumerates both worlds and keeps their ids distinguishable", () => {
    const catalog = buildBotCatalog({
      registry: [registered("acme:digest")],
      local: [localRow()],
      installations: [],
    })
    expect(catalog.map((e) => [e.definitionId, e.source])).toEqual([
      ["acme:digest", "plugin"],
      ["bdef_1", "local"],
    ])
  })

  it("puts plugin definitions first, each half alphabetical", () => {
    const catalog = buildBotCatalog({
      registry: [
        registered("acme:zeta", { name: "Zeta" }),
        registered("acme:alpha", { name: "Alpha" }),
      ],
      local: [localRow({ id: "b2", name: "Yankee" }), localRow({ id: "b1", name: "Bravo" })],
      installations: [],
    })
    expect(catalog.map((e) => e.name)).toEqual(["Alpha", "Zeta", "Bravo", "Yankee"])
  })

  it("counts existing installations per definition without hiding the row", () => {
    // Installing a second copy is a real thing to want. The count informs the
    // choice, it does not remove it.
    const catalog = buildBotCatalog({
      registry: [registered("acme:digest")],
      local: [],
      installations: [installation("acme:digest", "a"), installation("acme:digest", "b")],
    })
    expect(catalog).toHaveLength(1)
    expect(catalog[0]!.installedCount).toBe(2)
  })

  it("counts nothing for a definition no installation points at", () => {
    const catalog = buildBotCatalog({
      registry: [registered("acme:digest")],
      local: [],
      installations: [installation("other:bot")],
    })
    expect(catalog[0]!.installedCount).toBe(0)
  })

  it("splits required slots out of the full slot list", () => {
    const catalog = buildBotCatalog({
      registry: [
        registered("acme:digest", {
          requires: {
            credentials: [
              { id: "gh", label: "GitHub" },
              { id: "slack", label: "Slack", optional: true },
            ],
          },
        }),
      ],
      local: [],
      installations: [],
    })
    expect(catalog[0]!.slots.map((s) => s.id)).toEqual(["gh", "slack"])
    expect(catalog[0]!.requiredSlots.map((s) => s.id)).toEqual(["gh"])
  })

  it("marks a handler definition whose module never resolved", () => {
    const catalog = buildBotCatalog({
      registry: [registered("acme:h", { executor: "handler", entry: "./bot.js" })],
      local: [],
      installations: [],
    })
    expect(catalog[0]!.unresolvedHandler).toBe(true)
    expect(catalogEntryInstallable(catalog[0]!)).toBe(false)
  })

  it("does not mark a handler definition that did resolve", () => {
    const catalog = buildBotCatalog({
      registry: [
        registered("acme:h", { executor: "handler", entry: "./bot.js" }, async () => ({})),
      ],
      local: [],
      installations: [],
    })
    expect(catalog[0]!.unresolvedHandler).toBe(false)
    expect(catalogEntryInstallable(catalog[0]!)).toBe(true)
  })

  it("stays installable when a required credential is unbound", () => {
    // The installation is created `needs_setup` on purpose: install first,
    // bind afterwards, which is the order the detail pane is built for.
    const catalog = buildBotCatalog({
      registry: [
        registered("acme:digest", { requires: { credentials: [{ id: "gh", label: "GitHub" }] } }),
      ],
      local: [],
      installations: [],
    })
    expect(catalogEntryInstallable(catalog[0]!)).toBe(true)
  })

  it("omits absent optional fields rather than setting them undefined", () => {
    const catalog = buildBotCatalog({
      registry: [registered("acme:digest")],
      local: [],
      installations: [],
    })
    expect("description" in catalog[0]!).toBe(false)
    expect("configSchema" in catalog[0]!).toBe(false)
  })

  it("carries the owning plugin id for a plugin definition and none for a local one", () => {
    const catalog = buildBotCatalog({
      registry: [registered("acme:digest")],
      local: [localRow()],
      installations: [],
    })
    expect(catalog[0]!.pluginId).toBe("acme")
    expect("pluginId" in catalog[1]!).toBe(false)
  })
})

describe("matchesCatalogSearch", () => {
  const entry: BotCatalogEntry = {
    definitionId: "acme:digest",
    source: "plugin",
    name: "Daily digest",
    description: "Summarises the day",
    version: "1.0.0",
    executor: "workflow",
    triggers: [],
    slots: [],
    requiredSlots: [],
    pluginId: "acme",
    installedCount: 0,
    unresolvedHandler: false,
  }

  it("matches an empty query", () => {
    expect(matchesCatalogSearch(entry, "   ")).toBe(true)
  })

  it.each([
    ["name", "daily"],
    ["description", "summarises"],
    ["definition id", "acme:dig"],
    ["plugin id", "acme"],
  ])("matches on %s", (_label, query) => {
    expect(matchesCatalogSearch(entry, query)).toBe(true)
  })

  it("does not match something the entry never says", () => {
    expect(matchesCatalogSearch(entry, "telegram")).toBe(false)
  })

  it("filters a list", () => {
    const other = { ...entry, definitionId: "acme:other", name: "Triage" }
    expect(filterBotCatalog([entry, other], "triage").map((e) => e.name)).toEqual(["Triage"])
  })
})
