import { ProviderOperationHandlerRegistry } from "./registry"

const noop = async () => ({})

describe("ProviderOperationHandlerRegistry", () => {
  it("resolves provider before protocol before any", () => {
    const registry = new ProviderOperationHandlerRegistry()
    registry.register({
      operationId: "language.generate",
      providerMatch: { kind: "any" },
      support: "derived",
      handler: noop,
    })
    registry.register({
      operationId: "language.generate",
      providerMatch: { kind: "protocol", protocol: "openai" },
      support: "native",
      handler: noop,
    })
    registry.register({
      operationId: "language.generate",
      providerMatch: { kind: "provider", providerId: "acme" },
      support: "plugin",
      via: "acme:lang",
      handler: noop,
    })
    expect(registry.resolve("language.generate", "acme", "openai")?.providerMatch.kind).toBe(
      "provider"
    )
    expect(registry.resolve("language.generate", "other", "openai")?.providerMatch.kind).toBe(
      "protocol"
    )
    expect(registry.resolve("language.generate", "other", "anthropic")?.providerMatch.kind).toBe(
      "any"
    )
    expect(registry.resolve("embeddings.create", "other", "openai")).toBeUndefined()
  })

  it("unregisters exactly the registration handed back", () => {
    const registry = new ProviderOperationHandlerRegistry()
    const dispose = registry.register({
      operationId: "models.list",
      providerMatch: { kind: "any" },
      support: "derived",
      handler: noop,
    })
    expect(registry.listFor("models.list")).toHaveLength(1)
    dispose()
    dispose()
    expect(registry.listFor("models.list")).toHaveLength(0)
    expect(registry.list()).toHaveLength(0)
  })
})
