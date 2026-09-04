import type { PluginBotDef } from "@/types/plugin/plugin-bot"

import {
  __resetBotsForTesting,
  botDefinitionId,
  getBot,
  getBotEntry,
  listBotEntries,
  listBotIds,
  parseBotDefinitionId,
  registerBot,
  unregisterBotById,
  unregisterBotsByPlugin,
} from "./bot-registry"

jest.mock("@/lib/plugin/contracts/conflict-reporter", () => ({
  reportRegistryConflict: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { reportRegistryConflict } = require("@/lib/plugin/contracts/conflict-reporter") as {
  reportRegistryConflict: jest.Mock
}

function def(id: string, overrides: Partial<PluginBotDef> = {}): PluginBotDef {
  return {
    id,
    name: id,
    version: "1.0.0",
    executor: "handler",
    triggers: [{ id: "manual", kind: "manual" }],
    ...overrides,
  } as PluginBotDef
}

beforeEach(() => {
  __resetBotsForTesting()
  reportRegistryConflict.mockClear()
})

describe("botDefinitionId", () => {
  it("namespaces a raw manifest id by its owning plugin", () => {
    expect(botDefinitionId("acme", "digest")).toBe("acme:digest")
  })

  it("round-trips through parseBotDefinitionId", () => {
    expect(parseBotDefinitionId(botDefinitionId("acme", "digest"))).toEqual({
      pluginId: "acme",
      botId: "digest",
    })
  })

  it("keeps a bot id that itself contains a colon intact", () => {
    // Only the FIRST colon separates. A bot id may carry its own namespacing.
    expect(parseBotDefinitionId("acme:group:digest")).toEqual({
      pluginId: "acme",
      botId: "group:digest",
    })
  })

  it("returns null for an id that is not plugin-namespaced", () => {
    expect(parseBotDefinitionId("digest")).toBeNull()
    expect(parseBotDefinitionId(":digest")).toBeNull()
    expect(parseBotDefinitionId("acme:")).toBeNull()
  })
})

describe("bot registry", () => {
  it("stores under the namespaced id, not the raw one", () => {
    registerBot("digest", { id: "acme:digest", definition: def("digest") }, { pluginId: "acme" })

    expect(getBot("acme:digest")?.definition.id).toBe("digest")
    expect(getBot("digest")).toBeUndefined()
    expect(listBotIds()).toEqual(["acme:digest"])
  })

  it("keeps two plugins' same-named bots apart", () => {
    registerBot("digest", { id: "acme:digest", definition: def("digest") }, { pluginId: "acme" })
    registerBot("digest", { id: "beta:digest", definition: def("digest") }, { pluginId: "beta" })

    expect(listBotIds().sort()).toEqual(["acme:digest", "beta:digest"])
    expect(reportRegistryConflict).not.toHaveBeenCalled()
  })

  it("carries the resolved handler alongside the definition", async () => {
    const handler = jest.fn()
    registerBot(
      "digest",
      { id: "acme:digest", definition: def("digest"), handler },
      { pluginId: "acme" }
    )

    const entry = getBotEntry("acme:digest")
    expect(entry?.pluginId).toBe("acme")
    expect(entry?.entry.handler).toBe(handler)
  })

  it("lets the same plugin refresh its own bot, for hot reload", () => {
    registerBot("digest", { id: "acme:digest", definition: def("digest") }, { pluginId: "acme" })
    registerBot(
      "digest",
      { id: "acme:digest", definition: def("digest", { name: "Digest v2" }) },
      { pluginId: "acme" }
    )

    expect(getBot("acme:digest")?.definition.name).toBe("Digest v2")
    expect(reportRegistryConflict).not.toHaveBeenCalled()
  })

  it("drops every bot a plugin contributed in one shot", () => {
    registerBot("a", { id: "acme:a", definition: def("a") }, { pluginId: "acme" })
    registerBot("b", { id: "acme:b", definition: def("b") }, { pluginId: "acme" })
    registerBot("c", { id: "beta:c", definition: def("c") }, { pluginId: "beta" })

    expect(unregisterBotsByPlugin("acme")).toBe(2)
    expect(listBotIds()).toEqual(["beta:c"])
  })

  it("drops one bot by its namespaced id", () => {
    registerBot("a", { id: "acme:a", definition: def("a") }, { pluginId: "acme" })

    expect(unregisterBotById("acme:a")).toBe(true)
    expect(unregisterBotById("acme:a")).toBe(false)
    expect(listBotEntries()).toEqual([])
  })

  it("registers without a pluginId under the raw id, for host-owned bots", () => {
    // Creator-authored definitions are not plugin contributions, but a host
    // may still stage one through the same overlay in tests and previews.
    registerBot("local-only", { id: "local-only", definition: def("local-only") })
    expect(getBot("local-only")?.definition.id).toBe("local-only")
  })
})
