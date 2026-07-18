import { createContextPanelRegistry } from "./panel-registry"
import type { ContextPanelDefinition, ContextResource } from "@/types/context-workbench"

const resource: ContextResource = {
  kind: "canvas-document",
  documentId: "doc-1",
  revision: "1",
  capabilities: ["comments", "preview"],
}

function panel(
  id: string,
  overrides: Partial<ContextPanelDefinition> = {}
): ContextPanelDefinition {
  return {
    id,
    activity: "inspect",
    labelKey: `panels.${id}`,
    appliesTo: () => true,
    renderer: () => null,
    ...overrides,
  }
}

describe("context panel registry", () => {
  it("sorts native and plugin panels and supports additional activities", () => {
    const registry = createContextPanelRegistry()
    registry.register(panel("late", { order: 30 }))
    registry.register(panel("templates", { activity: "templates", order: 20 }))
    registry.register(panel("early", { order: 10 }))

    expect(registry.resolve(resource, new Set())).toEqual([
      expect.objectContaining({ id: "early" }),
      expect.objectContaining({ id: "templates", activity: "templates" }),
      expect.objectContaining({ id: "late" }),
    ])
  })

  it("filters by applicability, capabilities, and every required permission", () => {
    const registry = createContextPanelRegistry()
    registry.register(panel("wrong-resource", { appliesTo: () => false }))
    registry.register(panel("missing-capability", { requiredCapabilities: ["run"] }))
    registry.register(
      panel("allowed", {
        requiredCapabilities: ["comments"],
        requiredPermissions: ["extension:ui", "canvas:read"],
      })
    )

    expect(registry.resolve(resource, new Set(["extension:ui"]))).toEqual([])
    expect(registry.resolve(resource, new Set(["extension:ui", "canvas:read"]))).toEqual([
      expect.objectContaining({ id: "allowed" }),
    ])
  })

  it("rejects duplicate panel ids and unregisters all panels from one plugin", () => {
    const registry = createContextPanelRegistry()
    registry.register(panel("one", { pluginId: "plugin-a" }))
    registry.register(panel("two", { pluginId: "plugin-a" }))

    expect(() => registry.register(panel("one"))).toThrow(/one/)
    registry.unregisterPlugin("plugin-a")
    expect(registry.resolve(resource, new Set())).toEqual([])
  })

  it("notifies subscribers only for effective registry changes", () => {
    const registry = createContextPanelRegistry()
    const listener = jest.fn()
    const unsubscribe = registry.subscribe(listener)
    const unregister = registry.register(panel("registered"))
    expect(registry.getRevision()).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)

    registry.unregister("missing")
    registry.unregisterPlugin("missing-plugin")
    expect(listener).toHaveBeenCalledTimes(1)

    unregister()
    expect(registry.getRevision()).toBe(2)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    registry.register(panel("after-unsubscribe"))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("applies runtime permission gates and deterministic id ordering", () => {
    const registry = createContextPanelRegistry()
    registry.register(panel("z-panel", { order: 10 }))
    registry.register(panel("a-panel", { order: 10 }))
    registry.register(
      panel("runtime-denied", {
        hasRequiredPermissions: () => false,
      })
    )

    expect(registry.resolve(resource, new Set()).map((definition) => definition.id)).toEqual([
      "a-panel",
      "z-panel",
    ])
  })
})
