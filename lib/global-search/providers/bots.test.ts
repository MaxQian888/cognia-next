import {
  createBotsProvider,
  loadBotSearchRows,
  DEFAULT_BOTS_PROVIDER_DEPS,
  type BotsProviderDeps,
} from "./bots"
import type { GlobalSearchContext } from "../types"
import type { BotInstallationRow } from "@/lib/db/bot-types"

function installation(over: Partial<BotInstallationRow> = {}): BotInstallationRow {
  return {
    id: "boti_1",
    definitionId: "acme:review",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    status: "enabled",
    config: {},
    credentialBindings: {},
    createdAt: 1,
    updatedAt: 2_000,
    ...over,
  }
}

function deps(over: Partial<BotsProviderDeps> = {}): BotsProviderDeps {
  return {
    listBotInstallations: async () => [installation()],
    getPluginBotName: () => "Review",
    getLocalBotName: async () => undefined,
    ...over,
  }
}

const ctx = { now: 10_000, t: (key: string) => key } as unknown as GlobalSearchContext

describe("loadBotSearchRows", () => {
  it("joins an installation to the name a person would actually type", async () => {
    // The row carries only a `definitionId`, so a provider that skipped the
    // join would match `acme:review` and never "Review".
    expect(await loadBotSearchRows(deps())).toEqual([
      {
        id: "boti_1",
        definitionId: "acme:review",
        label: "Review",
        status: "enabled",
        timestamp: 2_000,
      },
    ])
  })

  it("reads a locally authored definition from the table, not the registry", async () => {
    const rows = await loadBotSearchRows(
      deps({
        listBotInstallations: async () => [installation({ definitionSource: "local" })],
        getPluginBotName: () => "wrong",
        getLocalBotName: async () => "Daily digest",
      })
    )
    expect(rows[0]?.label).toBe("Daily digest")
  })

  it("falls back to the definition id when nothing resolves", async () => {
    // An installation whose plugin is disabled still has to be findable, or
    // the only way to reach it is to already know it exists.
    const rows = await loadBotSearchRows(deps({ getPluginBotName: () => undefined }))
    expect(rows[0]?.label).toBe("acme:review")
  })

  it("survives a Dexie read failure instead of taking the palette down", async () => {
    const rows = await loadBotSearchRows(
      deps({
        listBotInstallations: async () => {
          throw new Error("db closed")
        },
      })
    )
    expect(rows).toEqual([])
  })

  it("survives a failing local-definition read for one row", async () => {
    const rows = await loadBotSearchRows(
      deps({
        listBotInstallations: async () => [installation({ definitionSource: "local" })],
        getLocalBotName: async () => {
          throw new Error("db closed")
        },
      })
    )
    expect(rows[0]?.label).toBe("acme:review")
  })
})

describe("botsProvider", () => {
  it("matches on the name and links into the console", async () => {
    const provider = createBotsProvider(deps())
    const result = await provider.search({
      query: { needle: "review", raw: "review" } as never,
      ctx,
      limit: 10,
      signal: new AbortController().signal,
    })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      id: "bot:boti_1",
      kind: "bot",
      title: "Review",
      subtitle: "acme:review",
      action: { type: "navigate", href: "/bots?bot=boti_1" },
    })
  })

  it("matches on the installation id a dead-letter report would quote", async () => {
    const provider = createBotsProvider(deps())
    const result = await provider.search({
      query: { needle: "boti_1", raw: "boti_1" } as never,
      ctx,
      limit: 10,
      signal: new AbortController().signal,
    })
    expect(result.items).toHaveLength(1)
  })
})

describe("DEFAULT_BOTS_PROVIDER_DEPS", () => {
  /**
   * Every case above injects its own deps, so nothing in the default wiring is
   * exercised by them. A wrong read would return `[]` forever and this suite
   * would stay green, which is exactly how the SSH list once shipped broken.
   */
  it("wires all three reads to something callable", () => {
    expect(typeof DEFAULT_BOTS_PROVIDER_DEPS.listBotInstallations).toBe("function")
    expect(typeof DEFAULT_BOTS_PROVIDER_DEPS.getPluginBotName).toBe("function")
    expect(typeof DEFAULT_BOTS_PROVIDER_DEPS.getLocalBotName).toBe("function")
  })

  it("reads plugin names straight from the registry overlay", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerBot, __resetBotsForTesting } = require("@/lib/plugin/registries/bot-registry")
    __resetBotsForTesting()
    registerBot(
      "review",
      {
        id: "review",
        definition: {
          name: "Review",
          version: "1.0.0",
          executor: "workflow",
          workflow: "wf_1",
          triggers: [],
        },
      },
      { pluginId: "acme" }
    )
    expect(DEFAULT_BOTS_PROVIDER_DEPS.getPluginBotName("acme:review")).toBe("Review")
    expect(DEFAULT_BOTS_PROVIDER_DEPS.getPluginBotName("acme:nope")).toBeUndefined()
    __resetBotsForTesting()
  })
})
