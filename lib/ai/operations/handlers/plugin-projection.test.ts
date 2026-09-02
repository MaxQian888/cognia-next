import { projectPluginCells } from "./plugin-projection"

const NO_ENTRIES = () => []

describe("projectPluginCells", () => {
  const base = {
    providerId: "acme-cloud",
    protocol: "openai" as const,
    baseURL: "https://acme.example/v1",
  }

  it("is empty when no plugin serves the provider", () => {
    expect(
      projectPluginCells(base, {
        balanceAdapters: NO_ENTRIES,
        limitsSources: NO_ENTRIES,
        protocolAdapters: NO_ENTRIES,
        operationAdapters: NO_ENTRIES,
      })
    ).toEqual([])
  })

  it("projects a balance adapter as a plugin-served balance.read", () => {
    const cells = projectPluginCells(base, {
      balanceAdapters: () => [
        {
          id: "acme:bal",
          pluginId: "acme",
          entry: {
            id: "acme:bal",
            key: "acme-cloud",
            name: "Acme balance",
            matches: (q) => q.providerKey === "acme-cloud",
            request: () => ({ url: "", headers: {} }),
            parse: () => ({
              fetchedAt: 0,
              providerKey: "acme-cloud",
              accountId: "a",
              kind: "credit",
              raw: {},
            }),
          },
        },
        {
          id: "other:bal",
          pluginId: "other",
          entry: {
            id: "other:bal",
            key: "elsewhere",
            matches: (q) => q.providerKey === "elsewhere",
            request: () => ({ url: "", headers: {} }),
            parse: () => ({
              fetchedAt: 0,
              providerKey: "elsewhere",
              accountId: "a",
              kind: "credit",
              raw: {},
            }),
          },
        },
      ],
      limitsSources: NO_ENTRIES,
      protocolAdapters: NO_ENTRIES,
      operationAdapters: NO_ENTRIES,
    })
    expect(cells).toEqual([
      {
        operationId: "balance.read",
        support: "plugin",
        availability: "ready",
        via: "acme:bal",
        note: "balance adapter Acme balance",
      },
    ])
  })

  it("matches the registry key of a relay id, so a wire suffix does not hide the adapter", () => {
    const cells = projectPluginCells(
      { ...base, providerId: "acme-cloud-anthropic", protocol: "anthropic" },
      {
        balanceAdapters: () => [
          {
            id: "bal",
            pluginId: "acme",
            entry: {
              id: "bal",
              key: "acme-cloud",
              matches: (q) => q.providerKey === "acme-cloud",
              request: () => ({ url: "", headers: {} }),
              parse: () => ({
                fetchedAt: 0,
                providerKey: "acme-cloud",
                accountId: "a",
                kind: "credit",
                raw: {},
              }),
            },
          },
        ],
        limitsSources: NO_ENTRIES,
        protocolAdapters: NO_ENTRIES,
        operationAdapters: NO_ENTRIES,
      }
    )
    expect(cells.map((c) => [c.operationId, c.via])).toEqual([["balance.read", "acme:bal"]])
  })

  it("projects a limits source as quota.read and rate-limits.read", () => {
    const cells = projectPluginCells(base, {
      balanceAdapters: NO_ENTRIES,
      limitsSources: () => [
        {
          id: "acme:limits",
          pluginId: "acme",
          entry: {
            id: "acme:limits",
            key: "acme-cloud",
            matches: (q) => q.baseUrl === "https://acme.example/v1",
            fetch: async () => null,
          },
        },
      ],
      protocolAdapters: NO_ENTRIES,
      operationAdapters: NO_ENTRIES,
    })
    expect(cells.map((c) => [c.operationId, c.via])).toEqual([
      ["quota.read", "acme:limits"],
      ["rate-limits.read", "acme:limits"],
    ])
  })

  it("projects a protocol adapter as the language pair when it is the provider's wire", () => {
    const deps = {
      balanceAdapters: NO_ENTRIES,
      limitsSources: NO_ENTRIES,
      protocolAdapters: () => [{ id: "acme:wire", label: "Acme wire", pluginId: "acme" }],
      operationAdapters: NO_ENTRIES,
    }
    expect(
      projectPluginCells({ ...base, protocol: "acme:wire" }, deps).map((c) => c.operationId)
    ).toEqual(["language.generate", "language.stream"])
    expect(projectPluginCells(base, deps)).toEqual([])
  })

  it("projects operation adapters by provider, protocol or any, and lets them win over legacy points", () => {
    const cells = projectPluginCells(base, {
      operationAdapters: () => [
        {
          id: "acme:img",
          pluginId: "acme",
          entry: {
            id: "acme:img",
            name: "Acme images",
            operationId: "images.generate",
            providerMatch: { kind: "provider", providerId: "acme-cloud" },
            handler: async () => ({}),
          },
        },
        {
          id: "acme:bal",
          pluginId: "acme",
          entry: {
            id: "acme:bal",
            operationId: "balance.read",
            providerMatch: { kind: "protocol", protocol: "openai" },
            handler: async () => ({}),
          },
        },
        {
          id: "acme:nope",
          pluginId: "acme",
          entry: {
            id: "acme:nope",
            operationId: "files.upload",
            providerMatch: { kind: "provider", providerId: "someone-else" },
            handler: async () => ({}),
          },
        },
        {
          id: "acme:all",
          pluginId: "acme",
          entry: {
            id: "acme:all",
            operationId: "tokens.count",
            providerMatch: { kind: "any" },
            handler: async () => ({}),
          },
        },
      ],
      balanceAdapters: () => [
        {
          id: "legacy:bal",
          pluginId: "legacy",
          entry: {
            id: "legacy:bal",
            key: "acme-cloud",
            matches: () => true,
            request: () => ({ url: "", headers: {} }),
            parse: () => ({
              fetchedAt: 0,
              providerKey: "acme-cloud",
              accountId: "a",
              kind: "credit",
              raw: {},
            }),
          },
        },
      ],
      limitsSources: NO_ENTRIES,
      protocolAdapters: NO_ENTRIES,
    })
    expect(cells.map((c) => [c.operationId, c.via, c.note])).toEqual([
      ["images.generate", "acme:img", "served by Acme images"],
      ["balance.read", "acme:bal", "served by acme:bal"],
      ["tokens.count", "acme:all", "served by acme:all"],
    ])
  })
})
