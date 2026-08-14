import {
  PluginServiceDuplicateProviderError,
  PluginServiceRegistry,
  type PluginServiceManifest,
} from "./service-registry"

describe("PluginServiceRegistry", () => {
  it("publishes only after provider commit and returns metadata only", () => {
    const registry = new PluginServiceRegistry()
    registry.beginProvider("workspace", 4, { "workspace.backend": "1.2.0" })
    expect(registry.isAvailable("workspace.backend")).toBe(false)

    registry.publishProvider("workspace", 4)

    expect(registry.getProvider("workspace.backend")).toEqual({
      serviceId: "workspace.backend",
      version: "1.2.0",
      providerPluginId: "workspace",
      generation: 4,
      status: "available",
      realmId: "global",
    })
  })

  it("reports required and optional service mismatches independently", () => {
    const registry = new PluginServiceRegistry()
    registry.beginProvider("workspace", 1, { "workspace.backend": "1.5.0" })
    registry.publishProvider("workspace", 1)

    expect(
      registry.evaluate(
        { "workspace.backend": ">=2", "missing.required": "*" },
        { "missing.optional": "^1" }
      )
    ).toEqual({
      required: [
        {
          serviceId: "workspace.backend",
          constraint: ">=2",
          kind: "version-mismatch",
          foundVersion: "1.5.0",
        },
        { serviceId: "missing.required", constraint: "*", kind: "missing" },
      ],
      optional: [{ serviceId: "missing.optional", constraint: "^1", kind: "missing" }],
    })
  })

  it("rejects duplicates and makes draining providers unavailable", () => {
    const registry = new PluginServiceRegistry()
    registry.beginProvider("a", 1, { service: "1.0.0" })
    expect(() => registry.beginProvider("b", 1, { service: "1.0.0" })).toThrow(
      PluginServiceDuplicateProviderError
    )
    registry.publishProvider("a", 1)
    registry.markProviderDraining("a", 1)
    expect(registry.isAvailable("service")).toBe(false)
    registry.removeProvider("a", 1)
    expect(registry.snapshot()).toEqual([])
  })

  it("allows a deterministic replacement only after the old provider is removed", () => {
    const registry = new PluginServiceRegistry()
    registry.beginProvider("old", 1, { service: "1.0.0" })
    registry.publishProvider("old", 1)
    expect(() => registry.beginProvider("replacement", 1, { service: "2.0.0" })).toThrow(
      PluginServiceDuplicateProviderError
    )

    registry.markProviderDraining("old", 1)
    registry.removeProvider("old", 1)
    registry.beginProvider("replacement", 1, { service: "2.0.0" })
    registry.publishProvider("replacement", 1)

    expect(registry.getProvider("service")).toMatchObject({
      providerPluginId: "replacement",
      version: "2.0.0",
    })
  })

  it("finds required-service cycles independently of activation order", () => {
    const registry = new PluginServiceRegistry()
    const manifests: PluginServiceManifest[] = [
      { id: "a", providesServices: { a: "1.0.0" }, requiresServices: { b: "^1" } },
      { id: "b", providesServices: { b: "1.0.0" }, requiresServices: { a: "^1" } },
      { id: "optional", optionalServices: { a: "^1" } },
    ]

    expect(registry.findRequiredCycles(manifests)).toEqual([["a", "b"]])

    registry.beginProvider("a", 1, { a: "1.0.0" })
    registry.publishProvider("a", 1)
    expect(registry.optionalConsumersOf("a", manifests)).toEqual(["optional"])
  })

  it("isolates realms and only permits catalog-approved overrides", () => {
    const registry = new PluginServiceRegistry({ realmOverridableServices: ["workspace.backend"] })
    registry.beginProvider("global", 1, { "workspace.backend": "1.0.0", fixed: "1.0.0" })
    registry.publishProvider("global", 1)
    registry.beginProvider("project", 1, { "workspace.backend": "2.0.0" }, "project:p1")
    registry.publishProvider("project", 1)

    expect(
      registry.getProvider("workspace.backend", { realmId: "session:s1", projectId: "p1" })
    ).toMatchObject({ providerPluginId: "project", realmId: "project:p1" })
    expect(registry.getProvider("fixed", { realmId: "project:p1" })).toMatchObject({
      providerPluginId: "global",
      realmId: "global",
    })
    expect(() => registry.beginProvider("bad", 1, { fixed: "2.0.0" }, "project:p1")).toThrow(
      "not realm-overridable"
    )
  })
})
